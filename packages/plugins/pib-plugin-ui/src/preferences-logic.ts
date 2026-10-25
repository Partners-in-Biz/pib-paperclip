/**
 * The logic behind `PreferencesPanel`, kept free of React so it can be tested without a DOM.
 * The descriptor and save-result shapes mirror `describePreferences` / `savePreferences` in pib-plugin-kit.
 */
export type PreferenceValue = string | number | boolean;
export type PreferenceValues = Record<string, PreferenceValue>;

export type PreferenceDescriptor = {
  id: string;
  type: "string" | "text" | "bool" | "int" | "enum";
  label: string;
  help?: string;
  default?: PreferenceValue;
  min?: number;
  max?: number;
  options?: readonly string[];
};

export type PreferencesLoadResult = { fields: PreferenceDescriptor[]; values: PreferenceValues };
export type PreferencesSaveResult =
  | { ok: true; values: PreferenceValues; previous?: PreferenceValues }
  | { ok: false; error: string };

/** What the form holds while editing: text for every input, a boolean for checkboxes. */
export type PreferencesDraft = Record<string, string | boolean>;

export function draftFromValues(fields: PreferenceDescriptor[], values: PreferenceValues): PreferencesDraft {
  const draft: PreferencesDraft = {};
  for (const field of fields) {
    const value = values[field.id] ?? field.default;
    draft[field.id] = field.type === "bool" ? value === true : value === undefined ? "" : String(value);
  }
  return draft;
}

function valueOf(field: PreferenceDescriptor, raw: string | boolean | undefined): PreferenceValue | string {
  if (field.type === "bool") return raw === true;
  const text = typeof raw === "string" ? raw : "";
  return field.type === "int" ? (text.trim() === "" ? "" : Number(text)) : text;
}

/** One message per invalid field id. Same limits the server enforces, so the user sees them before saving. */
export function validateDraft(fields: PreferenceDescriptor[], draft: PreferencesDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = valueOf(field, draft[field.id]);
    if (field.type === "string" || field.type === "text") {
      const text = String(value);
      if (field.max !== undefined && text.length > field.max) errors[field.id] = `${field.label} must be at most ${field.max} characters`;
    } else if (field.type === "int") {
      if (value === "" || !Number.isInteger(value)) errors[field.id] = `${field.label} must be a whole number`;
      else if (field.min !== undefined && (value as number) < field.min) errors[field.id] = `${field.label} must be at least ${field.min}`;
      else if (field.max !== undefined && (value as number) > field.max) errors[field.id] = `${field.label} must be at most ${field.max}`;
    } else if (field.type === "enum") {
      if (!field.options?.includes(String(value))) errors[field.id] = `${field.label} must be one of: ${(field.options ?? []).join(", ")}`;
    }
  }
  return errors;
}

/** Only the fields the user changed, so a save never rewrites a value they did not touch. */
export function changedPatch(fields: PreferenceDescriptor[], values: PreferenceValues, draft: PreferencesDraft): PreferenceValues {
  const patch: PreferenceValues = {};
  const base = draftFromValues(fields, values);
  for (const field of fields) {
    if (draft[field.id] !== base[field.id]) patch[field.id] = valueOf(field, draft[field.id]) as PreferenceValue;
  }
  return patch;
}

/** Ids from `confirmChange` that this patch touches (the panel asks before saving them). */
export function fieldsNeedingConfirm(patch: PreferenceValues, confirmChange: readonly string[] | undefined): string[] {
  return (confirmChange ?? []).filter((id) => Object.hasOwn(patch, id));
}

export type SaveOutcome =
  | { status: "invalid"; errors: Record<string, string> }
  | { status: "unchanged" }
  | { status: "confirm"; fieldIds: string[] }
  | { status: "saved"; values: PreferenceValues; previous: PreferenceValues }
  | { status: "failed"; error: string };

export async function submitPreferences(input: {
  fields: PreferenceDescriptor[];
  values: PreferenceValues;
  draft: PreferencesDraft;
  confirmChange?: readonly string[];
  confirmed?: boolean;
  save: (patch: PreferenceValues) => Promise<PreferencesSaveResult>;
}): Promise<SaveOutcome> {
  const errors = validateDraft(input.fields, input.draft);
  if (Object.keys(errors).length > 0) return { status: "invalid", errors };
  const patch = changedPatch(input.fields, input.values, input.draft);
  if (Object.keys(patch).length === 0) return { status: "unchanged" };
  const guarded = fieldsNeedingConfirm(patch, input.confirmChange);
  if (guarded.length > 0 && !input.confirmed) return { status: "confirm", fieldIds: guarded };
  try {
    const result = await input.save(patch);
    // The server's refusal text is shown as it came, never reworded.
    if (!result.ok) return { status: "failed", error: result.error };
    // Prefer the server's own "previous"; fall back to what the form was showing.
    return { status: "saved", values: result.values, previous: result.previous ?? input.values };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : typeof error === "string" ? error : (error as { message?: string } | null)?.message ?? "Request failed" };
  }
}
