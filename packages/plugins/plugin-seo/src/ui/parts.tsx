/**
 * Small shared pieces of the SEO page: banners, issue links, the plain-error
 * line with its Details, the breadcrumb and number helpers.
 */
import type { CSSProperties, ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { CircleAlert, Info, Pill, TriangleAlert, breakAnywhere, tokens, tone, useIsNarrow, type LucideIcon, type ToneName } from "@partnersinbiz/pib-plugin-ui";
import { agentTrouble, projectFixPath, RUNS_FIX, RUNS_TROUBLE } from "../engine/due.js";
import { plural, type PlainError } from "../engine/plain.js";
import { TEAM_SETUP_HREF } from "./role-skills.js";
import type { AgentState } from "./types.js";

/** What the host's `linkProps(path)` returns: in-app navigation on an anchor. */
export type LinkProps = ReturnType<ReturnType<typeof useHostNavigation>["linkProps"]>;

export const small: CSSProperties = { height: 32, fontSize: 12.5, padding: "0 12px" };

/** Cards in a row share its height; keep their content at the top. */
export const top = { alignContent: "start" } as const;

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** "https://www.acme.co.za/" → "acme.co.za". */
export function shortUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
}

function Glyph({ icon: I, color }: { icon: LucideIcon; color: string }) {
  return <I size={15} color={color} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />;
}

/** A tinted line with its action at the end (on a phone keep the text short so it stays one line). */
export function Banner({ tone: t, children, action }: { tone: "warn" | "info" | "bad"; children: ReactNode; action?: ReactNode }) {
  const narrow = useIsNarrow();
  const colors = tone(t);
  const glyph = t === "bad" ? CircleAlert : t === "warn" ? TriangleAlert : Info;
  return (
    <div
      role="status"
      style={{
        fontSize: 13,
        lineHeight: 1.5,
        padding: "9px 12px",
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${colors.solid}`,
        background: `linear-gradient(90deg, ${colors.soft}, transparent 70%), ${tokens.card}`,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <Glyph icon={glyph} color={colors.solid} />
      <div style={{ display: "grid", gap: 4, minWidth: 0, flex: narrow ? "1 1 0" : "1 1 220px" }}>{children}</div>
      {action ? <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

/** A small primary link styled like a button (the host only styles its own class names). */
export const linkButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 32,
  padding: "0 12px",
  borderRadius: 8,
  background: tokens.primary,
  color: tokens.primaryFg,
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export const quietLink: CSSProperties = { color: tokens.fg, fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", minHeight: 32, display: "inline-flex", alignItems: "center" };

export function IssueLink({ id, identifier, label }: { id: string | null; identifier?: string | null; label?: string }) {
  const nav = useHostNavigation();
  if (!id) return <span style={{ color: tokens.muted }}>—</span>;
  return (
    <a {...nav.linkProps(`/issues/${identifier ?? id}`)} style={{ color: tokens.fg, fontWeight: 500 }}>
      {label ?? identifier ?? "Open issue"}
    </a>
  );
}

/** The raw text behind a plain message, closed by default. */
export function RawDetails({ raw, label = "Details" }: { raw: string; label?: string }) {
  return (
    <details style={{ fontSize: 12 }}>
      <summary style={{ cursor: "pointer", color: tokens.muted, minHeight: 24 }}>{label}</summary>
      <code style={{ display: "block", marginTop: 6, padding: 8, borderRadius: 8, background: tokens.secondary, color: tokens.fg, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", ...breakAnywhere }}>{raw}</code>
    </details>
  );
}

/** A plain error (engine/plain.ts) with its raw text under Details. */
export function PlainProblem({ problem }: { problem: PlainError }) {
  const t: ToneName = problem.tone === "bad" ? "bad" : problem.tone === "warn" ? "warn" : "info";
  return (
    <div style={{ display: "grid", gap: 4, fontSize: 13, minWidth: 0 }}>
      <span style={{ color: t === "info" ? tokens.muted : tone(t).fg }}>{problem.text}</span>
      <RawDetails raw={problem.raw} />
    </div>
  );
}

export interface Crumb {
  label: string;
  link?: LinkProps | null;
}

/** "Northwind › SEO › site": the one way back from a sprint (the host's own Back is the browser's). */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" style={{ fontSize: 12.5, color: tokens.muted, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", minWidth: 0 }}>
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          {item.link ? (
            <a {...item.link} style={{ color: tokens.muted, textDecoration: "none", minHeight: 24, display: "inline-flex", alignItems: "center", ...breakAnywhere }}>{item.label}</a>
          ) : (
            <span aria-current="page" style={{ color: tokens.fg, fontWeight: 600, ...breakAnywhere }}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * One line per cause when due work is stuck: the SEO agent cannot work (fix
 * in Setup → Team), or the tasks' runs stop at the workspace check because the
 * project has no checkout of the site repo on the server (fix the project's
 * Codebase). `stuck` counts both; `stuckRuns` the second.
 */
export function StuckBanner({ stuck, stuckRuns = 0, runsProjectIds = [], agent }: { stuck: number; stuckRuns?: number; runsProjectIds?: string[]; agent: AgentState }) {
  const nav = useHostNavigation();
  const narrow = useIsNarrow();
  const byAgent = stuck - stuckRuns;
  if (byAgent <= 0 && stuckRuns <= 0) return null;
  return (
    <>
      {byAgent > 0 ? (
        <Banner tone="bad" action={<a {...nav.linkProps(TEAM_SETUP_HREF)} style={narrow ? compactLink : linkButton}>{narrow ? "Fix" : "Fix in Setup → Team"}</a>}>
          <span>
            <strong>{plural(byAgent, "task")} stuck:</strong> {agentTrouble(agent)}{narrow ? "." : ", so nothing moves until it is fixed."}
          </span>
        </Banner>
      ) : null}
      {stuckRuns > 0 ? (
        <Banner tone="bad" action={<a {...nav.linkProps(projectFixPath(runsProjectIds))} style={narrow ? compactLink : linkButton}>{narrow ? "Fix" : "Open the project"}</a>}>
          <span>
            <strong>{plural(stuckRuns, "task")} can't start:</strong> {RUNS_TROUBLE}.{narrow ? "" : ` ${RUNS_FIX}`}
          </span>
        </Banner>
      ) : null}
    </>
  );
}

/** A banner's action on a phone: a short text link with a 40px tap target. */
export const compactLink: CSSProperties = { display: "inline-flex", alignItems: "center", minHeight: 40, padding: "0 4px", color: tokens.fg, fontWeight: 650, fontSize: 13, whiteSpace: "nowrap", textDecoration: "underline" };

export function StatePill({ label, tone: t, size = "sm" }: { label: string; tone: ToneName; size?: "sm" | "md" }) {
  return <Pill tone={t} size={size} dot>{label}</Pill>;
}
