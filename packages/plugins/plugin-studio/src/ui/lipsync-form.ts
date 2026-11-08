/**
 * Lip-sync mode on the Generate page (PAR-8437): which options to list, which is preselected for the input type, the
 * warning shown before submit, and the one action call. Pure, so tests need no DOM. The server (lipsync.ts) resolves
 * and prices the job; nothing here decides spend.
 */
export type LipsyncInput = "audio" | "line";

export interface LipsyncOption {
  key: string;
  label: string;
  model: string;
  input: LipsyncInput;
  credits: number | null;
  price: string;
  qualityNote: string;
  isDefault: boolean;
}

export const MAX_LINE_CHARS = 500;

/** Every option for this input type, the company/code default first. None is hidden (Peet: the user chooses). */
export function optionsFor(options: readonly LipsyncOption[], input: LipsyncInput): LipsyncOption[] {
  return options.filter((o) => o.input === input).sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** The preselected key for an input type: the option the server flagged as default, else the first. */
export function defaultKey(options: readonly LipsyncOption[], input: LipsyncInput): string {
  const list = optionsFor(options, input);
  return (list.find((o) => o.isDefault) ?? list[0])?.key ?? "";
}

/** The picked key if it still fits the input type; otherwise that type's default (switching audio <-> line). */
export function keyFor(options: readonly LipsyncOption[], input: LipsyncInput, picked: string): string {
  return optionsFor(options, input).some((o) => o.key === picked) ? picked : defaultKey(options, input);
}

/** "Wan 3.0 Prime - About 5.4 credits per 5 s at 480p. Keeps our audio exactly..." */
export function optionText(o: LipsyncOption): string {
  return `${o.label} - ${o.price}${o.isDefault ? " (default)" : ""}`;
}

/** The server marks a risky option with a "Warning:" quality note (Seedance 2.5 reference); show it before submit. */
export function warningFor(options: readonly LipsyncOption[], key: string): string | null {
  const note = options.find((o) => o.key === key)?.qualityNote ?? "";
  return /^warning:/i.test(note) ? note.replace(/^warning:\s*/i, "Warning: this model ") : null;
}

export interface LipsyncForm {
  input: LipsyncInput;
  portraitAssetId: string;
  audioAssetId: string;
  line: string;
  provider: string;
}

/** Why the form can't be submitted yet, or null. */
export function problem(f: LipsyncForm): string | null {
  if (!f.portraitAssetId) return "Pick a portrait.";
  if (f.input === "audio") return f.audioAssetId ? null : "Pick an audio file.";
  const n = f.line.trim().length;
  return n === 0 ? "Type the line to say." : n > MAX_LINE_CHARS ? `The line is at most ${MAX_LINE_CHARS} characters.` : null;
}

/** The `studio-lipsync` action params. The chosen option goes as `provider`; the server rejects a mismatch. */
export function lipsyncParams(f: LipsyncForm): Record<string, unknown> {
  return {
    portraitAssetId: f.portraitAssetId,
    ...(f.input === "audio" ? { audioAssetId: f.audioAssetId } : { line: f.line.trim() }),
    ...(f.provider ? { provider: f.provider } : {}),
  };
}

/** Validates, then makes the one action call. */
export async function submitLipsync(run: (params: Record<string, unknown>) => Promise<unknown>, f: LipsyncForm): Promise<unknown> {
  const why = problem(f);
  if (why) throw new Error(why);
  return run(lipsyncParams(f));
}
