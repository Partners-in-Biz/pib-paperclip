/**
 * Google Drive setup checklist items and shared drive selection.
 *
 * Event names mirror plugin-crm and are used by both plugins:
 * - CRM emits `drive.binding` after drive_binding_* tools run
 * - Setup listens and stores, emits `drive.binding.set` when user picks a drive
 */
import type { StepItem } from "./bootstrap.js";

/** Event emitted by plugin-crm with drive binding status. Mirrors plugin-crm. */
export const DRIVE_BINDING_EVENT = "drive.binding";

/** Event emitted by plugin-setup when user selects a shared drive. Mirrors plugin-crm. */
export const DRIVE_BINDING_SET_EVENT = "drive.binding.set";

export interface DriveBindingCandidate {
  id: string;
  name: string;
}

export interface DriveBinding {
  companyId: string;
  connected: boolean;
  bound: boolean;
  sharedDriveId?: string;
  serviceAccountEmail?: string;
  serviceAccountIsMember: boolean;
  candidates: DriveBindingCandidate[];
}

/**
 * Parse and validate a drive binding event payload.
 * Whitelists keys only, caps candidates at 50, trims names to 200 chars.
 * Returns null if payload is invalid.
 */
export function parseDriveBindingEvent(payload: unknown): DriveBinding | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const companyId = p.companyId;
  if (typeof companyId !== "string") return null;

  const connected = p.connected === true;
  const bound = p.bound === true;
  const serviceAccountIsMember = p.serviceAccountIsMember === true;
  const sharedDriveId = typeof p.sharedDriveId === "string" ? p.sharedDriveId : undefined;
  const serviceAccountEmail = typeof p.serviceAccountEmail === "string" ? p.serviceAccountEmail : undefined;

  let candidates: DriveBindingCandidate[] = [];
  if (Array.isArray(p.candidates)) {
    candidates = p.candidates
      .slice(0, 50)
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        id: String(c.id ?? ""),
        name: typeof c.name === "string" ? c.name.trim().slice(0, 200) : "",
      }))
      .filter((c) => c.id && c.name);
  }

  return {
    companyId,
    connected,
    bound,
    sharedDriveId,
    serviceAccountEmail,
    serviceAccountIsMember,
    candidates,
  };
}

/**
 * Drive checklist items for the New company step.
 * Returns two StepItem entries: (a) "Connect Google Drive (read)",
 * (b) "Add the Drive service account ... to the company's Shared Drive".
 * With no drive data, both are open and use placeholder text without email.
 */
export function driveChecklist(drive: DriveBinding | null): StepItem[] {
  const items: StepItem[] = [];

  // Item 1: Connect Google Drive (read)
  items.push({
    key: "drive-connect",
    label: "Connect Google Drive (read)",
    status: drive?.connected ? "done" : "failed",
  });

  // Item 2: Add the Drive service account to the company's Shared Drive
  const accountEmail = drive?.serviceAccountEmail;
  const label = accountEmail
    ? `Add the Drive service account ${accountEmail} to the company's Shared Drive`
    : "Add the Drive service account to the company's Shared Drive";

  items.push({
    key: "drive-member",
    label,
    status: drive?.serviceAccountIsMember ? "done" : "failed",
    detail: accountEmail || undefined, // Store email separately for UI copy button
  });

  return items;
}
