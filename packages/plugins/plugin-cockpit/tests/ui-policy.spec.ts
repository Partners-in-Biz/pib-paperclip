import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PolicyView } from "../src/register-w1c-policy.js";
import { tabFromSearch } from "../src/ui/index.js";
import { PolicyBody } from "../src/ui/policy.js";

const linkFor = (href: string) => ({ href });
const view = (over: Partial<PolicyView> = {}): PolicyView => ({
  enabled: false,
  canChange: true,
  proposal: { name: "Peet standing approval 2026-10-19", roots: [{ identifier: "PAR-3983", issueId: "i1" }], classes: ["engineering-decision", "test-confirmation", "hire", "mapping-table"], exclusions: ["Credentials, keys, logins and tokens", "Legal and contracts"], floorHours: 4 },
  active: { enabled: false, name: "", rootIssueIds: [], classes: [], minHours: null },
  ledger: [],
  applied: [],
  ...over,
});
const html = (v: PolicyView, onToggle?: (e: boolean) => void) => renderToStaticMarkup(createElement(PolicyBody, { view: v, linkFor, onToggle }));

describe("Policy tab", () => {
  it("opens from ?tab=policy", () => {
    expect(tabFromSearch("?tab=policy")).toBe("policy");
  });

  it("shows the proposal, the exclusions and the floor with an empty state", () => {
    const out = html(view(), () => undefined);
    expect(out).toContain("Peet standing approval 2026-10-19");
    expect(out).toContain("PAR-3983");
    expect(out).toContain("Never covered");
    expect(out).toContain("at least 4 hours");
    expect(out).toContain("Turn on");
    expect(out).toContain("No changes yet");
    expect(out).toContain("has not answered anything yet");
  });

  it("offers Turn off when on, and no switch to anyone but the owner", () => {
    expect(html(view({ enabled: true }), () => undefined)).toContain("Turn off");
    const other = html(view({ canChange: false }), () => undefined);
    expect(other).not.toContain("Turn on");
    expect(other).toContain("Only the owner can change this");
  });

  it("lists the ledger and the policy-applied answers with the issue link", () => {
    const out = html(view({
      enabled: true,
      ledger: [{ id: "r1", action: "enable", detail: "on for 1 issue tree(s)", actor: "owner:u1", at: "2026-10-19T08:00:00.000Z" }],
      applied: [{ askId: "a1", issueId: "i9", issueIdentifier: "PAR-4001", issueTitle: "Pick the colour", question: "Which colour?", answer: "red", at: "2026-10-20T10:30:00.000Z" }],
    }));
    expect(out).toContain("Turned on");
    expect(out).toContain("2026-10-19 08:00 UTC");
    expect(out).toContain('href="/issues/PAR-4001"');
    expect(out).toContain("Answered: red");
  });
});
