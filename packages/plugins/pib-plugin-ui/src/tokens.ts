/**
 * Design tokens for PiB plugin pages: the host's theme variables, the semantic
 * status palette (ok / warn / bad / info / neutral / accent), a categorical
 * series palette for charts, and one accent colour per module.
 *
 * Every colour is a CSS custom property with a fallback, so a component renders
 * sensibly before the base styles are injected (tests, server rendering). The
 * light and dark values live in `THEME_CSS` (injected by `usePibBaseStyles`);
 * dark follows the host's `.dark` class on `<html>`.
 *
 * The status hues point at the host's own `--status-task-*` tokens, so a green
 * "ok" here is the same green as "Succeeded" in the host's Run Activity chart.
 */

export type ToneName = "ok" | "warn" | "bad" | "info" | "neutral" | "accent";

/** Tone names plus the aliases other code tends to use (`success`, `warning`, `error`, `danger`…). */
export type ToneInput =
  | ToneName
  | "success"
  | "done"
  | "good"
  | "warning"
  | "pending"
  | "error"
  | "danger"
  | "destructive"
  | "blocked"
  | "failed"
  | "primary"
  | "running"
  | "muted"
  | "default";

export interface ToneColors {
  name: ToneName;
  /** Dots, bars, chart fills, icons. */
  solid: string;
  /** Tinted background (pills, icon badges, highlighted rows). */
  soft: string;
  /** Border on a tinted surface. */
  border: string;
  /** Text on a tinted surface (or coloured text on the page). */
  fg: string;
}

export const TONE_NAMES: readonly ToneName[] = ["ok", "warn", "bad", "info", "neutral", "accent"];

/** Light-mode fallbacks (used before the injected styles load). */
const TONE_FALLBACK: Record<ToneName, string> = {
  ok: "#16a34a",
  warn: "#f59e0b",
  bad: "#dc2626",
  info: "#2563eb",
  neutral: "#737373",
  accent: "#2563eb",
};

/** Where each tone's solid colour comes from in the host. */
const TONE_SOURCE: Record<Exclude<ToneName, "accent">, string> = {
  ok: "var(--status-task-icon-done, #16a34a)",
  warn: "var(--status-task-todo, #f59e0b)",
  bad: "var(--status-task-icon-blocked, #dc2626)",
  info: "var(--status-task-icon-in_progress, #2563eb)",
  neutral: "var(--muted-foreground, #737373)",
};

const LIGHT_MIX = { soft: 10, border: 28, fg: 68, ink: "black" };
const DARK_MIX = { soft: 18, border: 38, fg: 72, ink: "white" };

function mix(color: string, pct: number, other: string): string {
  return `color-mix(in srgb, ${color} ${pct}%, ${other})`;
}

function toneVars(name: ToneName): ToneColors {
  const fb = TONE_FALLBACK[name];
  return {
    name,
    solid: `var(--pib-${name}, ${fb})`,
    soft: `var(--pib-${name}-soft, ${mix(fb, LIGHT_MIX.soft, "transparent")})`,
    border: `var(--pib-${name}-border, ${mix(fb, LIGHT_MIX.border, "transparent")})`,
    fg: `var(--pib-${name}-fg, ${mix(fb, LIGHT_MIX.fg, "black")})`,
  };
}

export const TONES: Record<ToneName, ToneColors> = Object.fromEntries(TONE_NAMES.map((name) => [name, toneVars(name)])) as Record<ToneName, ToneColors>;

const TONE_ALIASES: Record<string, ToneName> = {
  success: "ok",
  done: "ok",
  good: "ok",
  warning: "warn",
  pending: "warn",
  error: "bad",
  danger: "bad",
  destructive: "bad",
  blocked: "bad",
  failed: "bad",
  primary: "accent",
  running: "info",
  muted: "neutral",
  default: "neutral",
};

/** Normalises a tone name or alias; anything unknown is `neutral`. */
export function toneName(value: string | null | undefined): ToneName {
  if (!value) return "neutral";
  if ((TONE_NAMES as readonly string[]).includes(value)) return value as ToneName;
  return TONE_ALIASES[value] ?? "neutral";
}

/** Colours for a tone: `tone("bad").soft`, `tone("warning").fg`. Unknown names fall back to neutral. */
export function tone(value?: ToneInput | string | null): ToneColors {
  return TONES[toneName(value)];
}

// ── Categorical series (multi-series charts, legends) ───────────────────────

const SERIES_LIGHT = ["var(--pib-info)", "#7c3aed", "#0d9488", "#f59e0b", "#db2777", "var(--pib-ok)", "#ea580c", "#0891b2"];
const SERIES_DARK = ["var(--pib-info)", "#a78bfa", "#2dd4bf", "#fbbf24", "#f472b6", "var(--pib-ok)", "#fb923c", "#22d3ee"];
const SERIES_FALLBACK = ["#2563eb", "#7c3aed", "#0d9488", "#f59e0b", "#db2777", "#16a34a", "#ea580c", "#0891b2"];

/** Eight distinguishable colours for categories (not statuses). */
export const SERIES: string[] = SERIES_FALLBACK.map((fb, i) => `var(--pib-series-${i + 1}, ${fb})`);

/** Series colour by index (wraps). */
export function seriesColor(index: number): string {
  return SERIES[((index % SERIES.length) + SERIES.length) % SERIES.length]!;
}

// ── Module accents ──────────────────────────────────────────────────────────

export type ModuleKey =
  | "crm"
  | "social"
  | "seo"
  | "campaigns"
  | "billing"
  | "accounting"
  | "payroll"
  | "mailbox"
  | "partners"
  | "cockpit"
  | "setup";

export const MODULE_ACCENT_HUES: Record<ModuleKey, { label: string; light: string; dark: string }> = {
  crm: { label: "CRM", light: "#2563eb", dark: "#60a5fa" },
  social: { label: "Social", light: "#e11d48", dark: "#fb7185" },
  seo: { label: "SEO", light: "#16a34a", dark: "#4ade80" },
  campaigns: { label: "Campaigns", light: "#7c3aed", dark: "#a78bfa" },
  billing: { label: "Billing", light: "#059669", dark: "#34d399" },
  accounting: { label: "Accounting", light: "#0d9488", dark: "#2dd4bf" },
  payroll: { label: "Payroll", light: "#d97706", dark: "#fbbf24" },
  mailbox: { label: "Mailbox", light: "#ea580c", dark: "#fb923c" },
  partners: { label: "Partners", light: "#0891b2", dark: "#22d3ee" },
  cockpit: { label: "Cockpit", light: "#4f46e5", dark: "#818cf8" },
  setup: { label: "Setup", light: "#0284c7", dark: "#38bdf8" },
};

export const MODULE_KEYS = Object.keys(MODULE_ACCENT_HUES) as ModuleKey[];

/** `crm`, `partnersinbiz.crm`, `CRM` → `crm`. Null when it is not a module. */
export function moduleKeyOf(value: string | null | undefined): ModuleKey | null {
  if (!value) return null;
  const key = value.toLowerCase().replace(/^partnersinbiz\./, "").replace(/^plugin-/, "");
  return (MODULE_KEYS as string[]).includes(key) ? (key as ModuleKey) : null;
}

/** Accent colours for a module: same shape as a tone. */
export interface AccentColors extends Omit<ToneColors, "name"> {
  key: ModuleKey | null;
  label: string;
}

/** Soft/border/fg derived from any solid colour (theme-aware through `--pib-ink` and the mix percentages). */
export function derivedColors(solid: string): Omit<ToneColors, "name"> {
  return {
    solid,
    soft: `color-mix(in srgb, ${solid} var(--pib-soft-pct, ${LIGHT_MIX.soft}%), transparent)`,
    border: `color-mix(in srgb, ${solid} var(--pib-border-pct, ${LIGHT_MIX.border}%), transparent)`,
    fg: `color-mix(in srgb, ${solid} var(--pib-fg-pct, ${LIGHT_MIX.fg}%), var(--pib-ink, black))`,
  };
}

export function accentColors(key: ModuleKey): AccentColors {
  const hue = MODULE_ACCENT_HUES[key];
  return { key, label: hue.label, ...derivedColors(`var(--pib-accent-${key}, ${hue.light})`) };
}

// ── Injected CSS ────────────────────────────────────────────────────────────

function block(mode: typeof LIGHT_MIX, dark: boolean): string {
  const lines: string[] = [];
  for (const [name, source] of Object.entries(TONE_SOURCE)) lines.push(`--pib-${name}:${source}`);
  lines.push("--pib-accent:var(--pib-info)");
  for (const name of TONE_NAMES) {
    lines.push(`--pib-${name}-soft:${mix(`var(--pib-${name})`, mode.soft, "transparent")}`);
    lines.push(`--pib-${name}-border:${mix(`var(--pib-${name})`, mode.border, "transparent")}`);
    lines.push(`--pib-${name}-fg:${mix(`var(--pib-${name})`, mode.fg, mode.ink)}`);
  }
  lines.push(`--pib-ink:${mode.ink}`, `--pib-soft-pct:${mode.soft}%`, `--pib-border-pct:${mode.border}%`, `--pib-fg-pct:${mode.fg}%`);
  (dark ? SERIES_DARK : SERIES_LIGHT).forEach((color, i) => lines.push(`--pib-series-${i + 1}:${color}`));
  for (const key of MODULE_KEYS) lines.push(`--pib-accent-${key}:${dark ? MODULE_ACCENT_HUES[key].dark : MODULE_ACCENT_HUES[key].light}`);
  lines.push(`--pib-track:${dark ? "color-mix(in srgb, white 9%, transparent)" : "color-mix(in srgb, black 6%, transparent)"}`);
  return lines.join(";");
}

/** Light values on `:root`, dark values under the host's `.dark` class. */
export const THEME_CSS = `:root{${block(LIGHT_MIX, false)}}\n.dark,[data-theme="dark"]{${block(DARK_MIX, true)}}`;

/** Host theme tokens — the same CSS variables Paperclip uses in the board UI — plus the PiB palette. */
export const tokens = {
  border: "var(--border)",
  card: "var(--card)",
  bg: "var(--background)",
  fg: "var(--foreground)",
  muted: "var(--muted-foreground)",
  accent: "var(--accent)",
  primary: "var(--primary)",
  primaryFg: "var(--primary-foreground)",
  destructive: "var(--destructive)",
  input: "var(--input)",
  ring: "var(--ring)",
  secondary: "var(--secondary)",
  secondaryFg: "var(--secondary-foreground)",
  /** The host's `--chart-1..5`. In Paperclip these are greys; use `series` or `tones` for colour. */
  chart: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"],
  /** Semantic status colours: `tokens.tones.ok.solid`, `.soft`, `.border`, `.fg`. */
  tones: TONES,
  /** Categorical colours for chart series. */
  series: SERIES,
  /** Empty part of a bar, ring or track. */
  track: "var(--pib-track, color-mix(in srgb, black 6%, transparent))",
};
