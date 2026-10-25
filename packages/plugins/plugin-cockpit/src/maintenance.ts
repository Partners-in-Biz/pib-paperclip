/**
 * Release notes and the maintenance window (Cockpit → Maintenance).
 *
 * The poster writes one comment per release note on the company's System health issue; the first
 * line is a marker: `<!-- pib-release-note v1 {json} -->`. This module only reads them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getHealthIssue } from "./db.js";

/** Stop-first releases run daily 01:00-04:00 UTC (03:00-06:00 SAST); weekly upkeep is Sundays 03:00 UTC and only reports. No config override. */
export const MAINTENANCE_WINDOW = {
  stopFirst: { startUtc: "01:00", endUtc: "04:00", startSast: "03:00", endSast: "06:00", days: "daily" },
  weekly: { day: "Sunday", startUtc: "03:00", mode: "report-only" },
} as const;

export const RELEASE_NOTE_PHASES = ["planned", "live", "cancelled"] as const;
export const RELEASE_NOTE_REASONS = ["migration", "capability", "both"] as const;

export type ReleaseNotePhase = (typeof RELEASE_NOTE_PHASES)[number];

export interface ReleaseNote {
  id: string;
  phase: ReleaseNotePhase;
  plugin: string;
  version: string;
  reason: (typeof RELEASE_NOTE_REASONS)[number];
  windowStartUtc: string;
  windowEndUtc: string;
  downtimeMinutes: number;
  /** When the comment was posted. */
  postedAt: string;
}

export interface MaintenanceView {
  window: typeof MAINTENANCE_WINDOW.stopFirst;
  weekly: typeof MAINTENANCE_WINDOW.weekly;
  next: ReleaseNote | null;
  recent: ReleaseNote[];
}

const MARKER = /^\s*<!--\s*pib-release-note\s+v(\S+)\s+(\{.*\})\s*-->/;
const RECENT = 5;
const WEEK_MS = 7 * 86_400_000;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value: unknown): string | null {
  const s = str(value);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}

/** Reads the marker on the first line of a comment. Null when there is none, the version is not v1, the JSON is bad or a field is wrong. */
export function parseReleaseNote(body: unknown, postedAt: string): ReleaseNote | null {
  if (typeof body !== "string") return null;
  const match = MARKER.exec(body.split("\n", 1)[0] ?? "");
  if (!match || match[1] !== "1") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[2]!);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const plugin = str(r.plugin);
  const version = str(r.version);
  const windowStartUtc = iso(r.windowStartUtc);
  const windowEndUtc = iso(r.windowEndUtc);
  const phase = RELEASE_NOTE_PHASES.find((p) => p === r.phase);
  const reason = RELEASE_NOTE_REASONS.find((p) => p === r.reason);
  const downtime = r.downtimeMinutes;
  if (!id || !plugin || !version || !windowStartUtc || !windowEndUtc || !phase || !reason) return null;
  if (typeof downtime !== "number" || !Number.isInteger(downtime) || downtime < 0) return null;
  return { id, phase, plugin, version, reason, windowStartUtc, windowEndUtc, downtimeMinutes: downtime, postedAt };
}

/** `notes` oldest first. Next = the latest planned note still ahead (within 7 days) that no later live or cancelled note of the same id closed. */
export function maintenanceView(notes: ReleaseNote[], now: Date): MaintenanceView {
  const t = now.getTime();
  let next: ReleaseNote | null = null;
  notes.forEach((note, i) => {
    if (note.phase !== "planned") return;
    if (Date.parse(note.windowEndUtc) <= t || Date.parse(note.windowStartUtc) > t + WEEK_MS) return;
    if (notes.slice(i + 1).some((later) => later.id === note.id && later.phase !== "planned")) return;
    next = note;
  });
  return { window: MAINTENANCE_WINDOW.stopFirst, weekly: MAINTENANCE_WINDOW.weekly, next, recent: notes.slice(-RECENT).reverse() };
}

/** Loads the view for one company. No health issue (or no readable comments) gives an empty `next` and `recent`. */
export async function loadMaintenance(ctx: PluginContext, companyId: string, now: Date): Promise<MaintenanceView> {
  const health = await getHealthIssue(ctx, companyId);
  if (!health) return maintenanceView([], now);
  const comments = await ctx.issues.listComments(health.issueId, companyId);
  const notes = comments
    .filter((c) => !c.deletedAt)
    .sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)))
    .map((c) => parseReleaseNote(c.body, new Date(c.createdAt).toISOString()))
    .filter((n): n is ReleaseNote => n !== null);
  return maintenanceView(notes, now);
}
