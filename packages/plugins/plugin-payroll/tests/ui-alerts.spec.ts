/**
 * The Payroll page's warning lines: one short line per problem, each with
 * its fix, the same on every tab.
 */
import { describe, expect, it } from "vitest";
import { pageAlerts, type AlertInput } from "../src/ui/alerts.js";

const ready: AlertInput = {
  settings: { saved: true, encryptionKey: true, privateStorage: true },
  rules: { id: "za-2026-27-v1", taxYear: "2026/27", unverified: [{}, {}, {}, {}] },
  rulesReviewed: true,
};

describe("page alerts", () => {
  it("shows nothing when everything is in place", () => {
    expect(pageAlerts(ready)).toEqual([]);
  });

  it("asks for the settings once while they are not saved (not the key and storage too)", () => {
    const alerts = pageAlerts({ ...ready, settings: { saved: false, encryptionKey: false, privateStorage: false } });
    expect(alerts).toEqual([{ key: "settings", tone: "warn", text: "Payroll settings aren't saved yet.", actionLabel: "Open settings", action: { kind: "settings" } }]);
  });

  it("points at the settings for a missing encryption key or private storage", () => {
    const alerts = pageAlerts({ ...ready, settings: { saved: true, encryptionKey: false, privateStorage: false } });
    expect(alerts.map((a) => a.key)).toEqual(["key", "storage"]);
    expect(alerts.every((a) => a.action.kind === "settings" && a.actionLabel === "Open settings")).toBe(true);
    expect(alerts[0]!.text).toBe("Set the encryption key before you add staff ID, tax and bank details.");
  });

  it("asks for the accountant's check in one line, with Review opening the Statutory tab", () => {
    const alerts = pageAlerts({ ...ready, rulesReviewed: false });
    expect(alerts).toEqual([{ key: "rules-check", tone: "warn", text: "4 tax rules need your accountant's check.", actionLabel: "Review", action: { kind: "tab", tab: "statutory" } }]);
    expect(pageAlerts({ ...ready, rulesReviewed: false, rules: { ...ready.rules, unverified: [{}] } })[0]!.text).toBe("1 tax rule needs your accountant's check.");
    // Nothing to check: no line.
    expect(pageAlerts({ ...ready, rulesReviewed: false, rules: { ...ready.rules, unverified: [] } })).toEqual([]);
  });

  it("says when no rules are loaded (instead of asking for a check)", () => {
    const alerts = pageAlerts({ ...ready, rulesReviewed: false, rules: { id: null, taxYear: "2031/32", unverified: [] } });
    expect(alerts).toEqual([{ key: "rules-missing", tone: "bad", text: "No tax rules are loaded for 2031/32, so pay runs can't be calculated.", actionLabel: "Details", action: { kind: "tab", tab: "statutory" } }]);
  });

  it("keeps every line short", () => {
    const all = pageAlerts({ settings: { saved: true, encryptionKey: false, privateStorage: false }, rules: { id: "x", taxYear: "2026/27", unverified: [{}, {}] }, rulesReviewed: false });
    expect(all).toHaveLength(3);
    for (const alert of all) expect(alert.text.length).toBeLessThanOrEqual(80);
  });
});
