import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PreferencesPanel,
  PreferencesView,
  changedPatch,
  draftFromValues,
  submitPreferences,
  validateDraft,
  type PreferenceDescriptor,
  type PreferencesSaveResult,
} from "@partnersinbiz/pib-plugin-ui";

const fields: PreferenceDescriptor[] = [
  { id: "fromName", type: "string", label: "Sender name", help: "Shown as the sender on every email.", max: 20 },
  { id: "signature", type: "text", label: "Signature", max: 100 },
  { id: "replyIssues", type: "bool", label: "Reply issues", default: true },
  { id: "dueDays", type: "int", label: "Due days", min: 1, max: 90, default: 14 },
  { id: "timezone", type: "enum", label: "Timezone", options: ["Africa/Johannesburg", "UTC"], default: "UTC" },
];
const values = { fromName: "Acme", signature: "", replyIssues: true, dueDays: 14, timezone: "UTC" };

describe("PreferencesPanel logic", () => {
  it("builds a draft from values, falling back to defaults", () => {
    expect(draftFromValues(fields, { fromName: "Acme" })).toMatchObject({ fromName: "Acme", replyIssues: true, dueDays: "14", timezone: "UTC" });
  });

  it("reports validation messages per field", () => {
    const draft = { ...draftFromValues(fields, values), fromName: "x".repeat(21), dueDays: "0", timezone: "Mars" };
    expect(validateDraft(fields, draft)).toEqual({
      fromName: "Sender name must be at most 20 characters",
      dueDays: "Due days must be at least 1",
      timezone: "Timezone must be one of: Africa/Johannesburg, UTC",
    });
    expect(validateDraft(fields, { ...draftFromValues(fields, values), dueDays: "1.5" }).dueDays).toBe("Due days must be a whole number");
    expect(validateDraft(fields, { ...draftFromValues(fields, values), dueDays: "" }).dueDays).toBe("Due days must be a whole number");
  });

  it("sends only changed fields, typed", () => {
    const draft = { ...draftFromValues(fields, values), dueDays: "30", replyIssues: false };
    expect(changedPatch(fields, values, draft)).toEqual({ dueDays: 30, replyIssues: false });
  });

  it("does not call save when nothing changed or input is invalid", async () => {
    const save = vi.fn();
    const draft = draftFromValues(fields, values);
    expect(await submitPreferences({ fields, values, draft, save })).toEqual({ status: "unchanged" });
    const bad = await submitPreferences({ fields, values, draft: { ...draft, dueDays: "999" }, save });
    expect(bad.status).toBe("invalid");
    expect(save).not.toHaveBeenCalled();
  });

  it("saves and returns the previous value", async () => {
    const save = vi.fn(async (): Promise<PreferencesSaveResult> => ({ ok: true, values: { ...values, fromName: "Beta" }, previous: values }));
    const outcome = await submitPreferences({ fields, values, draft: { ...draftFromValues(fields, values), fromName: "Beta" }, save });
    expect(save).toHaveBeenCalledWith({ fromName: "Beta" });
    expect(outcome).toEqual({ status: "saved", values: { ...values, fromName: "Beta" }, previous: values });
  });

  it("returns the server refusal verbatim", async () => {
    const save = async (): Promise<PreferencesSaveResult> => ({ ok: false, error: "Only a company owner or admin can change preferences" });
    const outcome = await submitPreferences({ fields, values, draft: { ...draftFromValues(fields, values), fromName: "Beta" }, save });
    expect(outcome).toEqual({ status: "failed", error: "Only a company owner or admin can change preferences" });
  });

  it("turns a thrown action error into a failed state", async () => {
    const save = async () => { throw { code: -32001, message: "Cannot verify your role" }; };
    const outcome = await submitPreferences({ fields, values, draft: { ...draftFromValues(fields, values), fromName: "Beta" }, save });
    expect(outcome).toEqual({ status: "failed", error: "Cannot verify your role" });
  });

  it("asks to confirm guarded fields first, then saves once confirmed", async () => {
    const save = vi.fn(async (): Promise<PreferencesSaveResult> => ({ ok: true, values: { ...values, fromName: "Beta" }, previous: values }));
    const input = { fields, values, draft: { ...draftFromValues(fields, values), fromName: "Beta" }, confirmChange: ["fromName"], save };
    expect(await submitPreferences(input)).toEqual({ status: "confirm", fieldIds: ["fromName"] });
    expect(save).not.toHaveBeenCalled();
    expect((await submitPreferences({ ...input, confirmed: true })).status).toBe("saved");
    // An unguarded change needs no confirm.
    const other = await submitPreferences({ ...input, draft: { ...draftFromValues(fields, values), dueDays: "20" } });
    expect(other.status).toBe("saved");
  });
});

describe("PreferencesView", () => {
  const draft = draftFromValues(fields, values);
  const render = (props: Partial<Parameters<typeof PreferencesView>[0]> = {}) =>
    renderToStaticMarkup(createElement(PreferencesView, { fields, draft, ...props }));

  it("shows the standing notes, every field type and help text", () => {
    const html = render();
    expect(html).toContain("Only owners and admins can change these");
    expect(html).toContain("Used when sending; no instance admin needed");
    expect(html).toContain("Shown as the sender on every email.");
    expect(html).toContain("<textarea");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="number"');
    expect(html).toContain("<select");
  });

  it("shows validation messages, the refusal and the previous value", () => {
    expect(render({ errors: { dueDays: "Due days must be at least 1" } })).toContain("Due days must be at least 1");
    expect(render({ failure: "Only a company owner or admin can change preferences" })).toContain("Only a company owner or admin can change preferences");
    const html = render({ saved: { previous: { fromName: "Acme" }, changed: ["fromName"] } });
    expect(html).toContain("Saved.");
    expect(html).toContain("Sender name was Acme");
  });

  it("shows the confirm step instead of Save", () => {
    const html = render({ confirming: ["fromName"] });
    expect(html).toContain("Confirm change to Sender name");
    expect(html).toContain("Confirm and save");
    expect(html).not.toContain(">Save<");
  });

  it("renders empty and loading states", () => {
    expect(render({ fields: [], draft: {} })).toContain("No preferences to set.");
    expect(render({ fields: [], draft: {}, loading: true })).toContain("Loading…");
  });

  it("mounts the panel in a loading state before load resolves", () => {
    const html = renderToStaticMarkup(createElement(PreferencesPanel, { load: () => new Promise<{ fields: PreferenceDescriptor[]; values: typeof values }>(() => {}), save: async () => ({ ok: true as const, values }) }));
    expect(html).toContain("Loading…");
  });
});
