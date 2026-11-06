/**
 * The settings chips in the canvas side panel, and the header's credit line. Pure (no Node or database imports): the
 * page bundle uses it, and the worker still checks every value again through the same estimate and generate actions.
 *
 * Every chip of the old canvas stays on screen. One the chosen model doesn't accept is disabled with the reason; it is
 * never hidden and never faked. Checked against MODEL_CATALOG (2026-11-06):
 * - aspect and resolution: each model lists its own values (`ratios`, `resolutions`), so a chip is enabled only when
 *   the model lists it. A model that lists none takes no such field.
 * - quality: no model in the catalog has a quality field and the worker sends none, so Draft / Standard / High are
 *   always disabled. They turn on when a model gains one.
 */

export const ASPECT_CHIPS = ["1:1", "9:16", "16:9", "4:5", "3:2"] as const;
export const RESOLUTION_CHIPS = ["1k", "2k", "4k"] as const;
export const QUALITY_CHIPS = ["Draft", "Standard", "High"] as const;
/** Same as MAX_BATCH in generation.ts (a test keeps them equal). */
export const BATCH_MAX = 8;

export interface SettingsModel { id: string; label: string; ratios: readonly string[]; resolutions: readonly string[]; qualities?: readonly string[] }
export interface Chip { value: string; disabled: string | null }

function chips(wanted: readonly string[], offered: readonly string[], extras: boolean, field: string, model: SettingsModel | undefined): Chip[] {
  const why = !model
    ? "Pick a model first"
    : offered.length === 0
      ? `${model.label} takes no ${field} setting`
      : null;
  const list = extras ? [...wanted, ...offered.filter((v) => !wanted.includes(v))] : [...wanted];
  return list.map((value) => ({
    value,
    disabled: why ?? (offered.includes(value) ? null : `${model?.label ?? "This model"} doesn't offer ${value}`),
  }));
}

/** Aspect chips: the five of the old canvas, then any other ratio the model offers (so no offered value is unreachable). */
export function aspectChips(model: SettingsModel | undefined): Chip[] {
  return chips(ASPECT_CHIPS, model?.ratios ?? [], true, "aspect ratio", model);
}

/** Resolution chips: 1k, 2k, 4k, then others the model offers (Soul takes 720p and 1080p). */
export function resolutionChips(model: SettingsModel | undefined): Chip[] {
  return chips(RESOLUTION_CHIPS, model?.resolutions ?? [], true, "resolution", model);
}

/** Quality chips: disabled for every model until one of them lists `qualities`. */
export function qualityChips(model: SettingsModel | undefined): Chip[] {
  const offered = model?.qualities ?? [];
  const why = !model ? "Pick a model first" : offered.length === 0 ? "No model in the catalog takes a quality setting yet" : null;
  return QUALITY_CHIPS.map((value) => ({ value, disabled: why ?? (offered.includes(value) ? null : `${model?.label ?? "This model"} doesn't offer ${value}`) }));
}

/** One visible line saying why some chips of a group are off: the shared reason, or which values the model lacks. */
export function disabledNote(group: readonly Chip[], model: SettingsModel | undefined): string | null {
  const off = group.filter((c) => c.disabled);
  if (off.length === 0) return null;
  const reasons = new Set(off.map((c) => c.disabled));
  if (reasons.size === 1 && off.length === group.length) return off[0].disabled;
  return `${model?.label ?? "This model"} doesn't offer ${off.map((c) => c.value).join(", ")}`;
}

/** The value to send: the picked one if the model offers it, else the model's first. Undefined when it takes none. */
export function effectiveValue(picked: string | undefined, offered: readonly string[]): string | undefined {
  return picked && offered.includes(picked) ? picked : offered[0];
}

/** The batch stepper's value kept inside 1..BATCH_MAX. */
export function clampBatch(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(BATCH_MAX, Math.max(1, n)) : 1;
}

interface OverviewCredits {
  companyUsed: number;
  caps: Array<{ scopeKey: string; monthlyCredits: number }>;
  clientUsage: Array<{ scopeKey: string; used: number }>;
}

export interface HeaderCredits { used: number; cap: number | null; scope: "client" | "company" }

/**
 * Credits used this month against the cap that applies to this board, as `effectiveCap` in ledger.ts picks it: the
 * client's own cap when it has one (measured on that client's work), else the company cap, else the default cap
 * (both measured on the company's work). No cap anywhere: cap is null and generation is off.
 */
export function headerCredits(overview: OverviewCredits, client: string | undefined): HeaderCredits {
  const cap = (key: string) => overview.caps.find((c) => c.scopeKey === key)?.monthlyCredits;
  const own = client ? cap(client) : undefined;
  if (client && own !== undefined) return { used: overview.clientUsage.find((u) => u.scopeKey === client)?.used ?? 0, cap: own, scope: "client" };
  return { used: overview.companyUsed, cap: cap("company") ?? cap("default") ?? null, scope: "company" };
}
