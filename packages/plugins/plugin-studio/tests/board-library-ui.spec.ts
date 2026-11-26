import { describe, expect, it } from "vitest";
import { ASK_LINE, clientNotes, clientReplyFrom, confirmText, currentLink, driveClientOf, pickerValue, readOnlyLine, showPicker, studioCardCount, MISSING_VALUE, type BoardClientReply } from "../src/ui/board-client.js";
import { STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../src/plugin-key.js";
import { estimateFromReply, isClientChanged, refusalText } from "../src/ui/board-generate.js";

const acme = { kind: "company" as const, ref: "company:c1", name: "Acme" };
const base: BoardClientReply = { effective: null, source: null, dormant: null, missing: null, canSet: false, withheld: false };

describe("library panel client header (PAR-14848)", () => {
  it("the picker is for owner/admin on a board whose project has no client", () => {
    expect(showPicker({ ...base, canSet: true })).toBe(true);
    expect(showPicker({ ...base, canSet: true, source: "board", effective: acme })).toBe(true);
    expect(showPicker({ ...base, canSet: true, source: "project", effective: acme })).toBe(false);
    expect(showPicker({ ...base, canSet: false })).toBe(false);
    expect(showPicker({ ...base, canSet: true, withheld: true })).toBe(false);
  });

  it("read-only line: project client, own work, withheld", () => {
    expect(readOnlyLine({ ...base, source: "project", effective: acme }, "Website")).toBe("Acme (from project Website)");
    expect(readOnlyLine({ ...base, source: "project", effective: acme }, null)).toBe("Acme (from project this board's project)");
    expect(readOnlyLine(base, null)).toBe("Own work");
    expect(readOnlyLine({ ...base, withheld: true }, null)).toBe("Client work");
  });

  it("members are asked to find an owner or admin; owners and project boards are not", () => {
    expect(clientNotes(base)).toEqual([ASK_LINE]);
    expect(clientNotes({ ...base, canSet: true })).toEqual([]);
    expect(clientNotes({ ...base, source: "project", effective: acme })).toEqual([]);
    expect(clientNotes({ ...base, withheld: true })).toEqual([]);
  });

  it("dormant and missing notes", () => {
    expect(clientNotes({ ...base, source: "project", effective: acme, dormant: { ref: "company:c2", name: "Beta" }, canSet: true })[0]).toMatch(/Beta.*isn't used/);
    const missing = { ...base, missing: { ref: "company:c9", name: "Gone Ltd" } };
    expect(clientNotes({ ...missing, canSet: true })[0]).toMatch(/Gone Ltd.*Pick another client/);
    expect(clientNotes(missing)[0]).toMatch(/off until a company owner or admin/);
    expect(pickerValue({ ...missing, canSet: true })).toBe(MISSING_VALUE);
  });

  it("expected is the stored link: board source, or the missing one; null otherwise", () => {
    expect(currentLink({ ...base, source: "board", effective: acme })).toBe("company:c1");
    expect(currentLink({ ...base, source: "project", effective: acme })).toBeNull();
    expect(currentLink({ ...base, missing: { ref: "company:c9", name: "x" } })).toBe("company:c9");
    expect(currentLink(base)).toBeNull();
  });

  it("From Drive: the effective client, own for own work, hidden for viewers, withheld and missing", () => {
    expect(driveClientOf({ ...base, source: "board", effective: acme }, true)).toBe("company:c1");
    expect(driveClientOf(base, true)).toBe("own");
    expect(driveClientOf(base, false)).toBeNull();
    expect(driveClientOf({ ...base, withheld: true }, true)).toBeNull();
    expect(driveClientOf({ ...base, missing: { ref: "company:c9", name: "x" } }, true)).toBeNull();
  });

  it("counts only live Studio media cards, for the confirm", () => {
    const card = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: "embed", data: { data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD } }, ...extra });
    expect(studioCardCount([])).toBe(0);
    expect(studioCardCount([{ key: "n", kind: "note" }])).toBe(0);
    expect(studioCardCount([card("a"), card("b", { deletedAt: "2026-11-01" }), { key: "g", kind: "embed", data: { data: { plugin: STUDIO_PLUGIN_KEY, type: "studio-generate" } } }, card("c")])).toBe(2);
  });

  it("confirm text names the client and the placeholders", () => {
    expect(confirmText({ client: "company:c1", label: "Acme", cards: 1 })).toMatch(/Switch this board to Acme\? 1 Studio card on this board will show placeholders/);
    expect(confirmText({ client: null, label: "Own work", cards: 3 })).toMatch(/3 Studio cards.*your own work/);
  });

  it("clientReplyFrom tolerates a bare answer", () => {
    expect(clientReplyFrom(null)).toEqual(base);
    expect(clientReplyFrom({ canSet: true, clients: [acme] }).clients).toEqual([acme]);
  });
});

describe("generate card and a changed client (PAR-14848)", () => {
  it("the estimate keeps the client it priced for, to send back as expectedClient", () => {
    expect(estimateFromReply({ creditsTotal: 2, dailyLimit: 5, usedToday: 1, client: "company:c1", clientName: "Acme" })).toMatchObject({ client: "company:c1", payer: "Acme" });
    expect(estimateFromReply({ creditsTotal: 2 })).toMatchObject({ client: null, payer: "Own work" });
  });

  it("board_client_changed is recognised and its text is shown", () => {
    const e = Object.assign(new Error("This board's client changed since the estimate."), { code: "board_client_changed" });
    expect(isClientChanged(e)).toBe(true);
    expect(isClientChanged(new Error("x"))).toBe(false);
    expect(refusalText(e)).toMatch(/client changed/);
  });
});
