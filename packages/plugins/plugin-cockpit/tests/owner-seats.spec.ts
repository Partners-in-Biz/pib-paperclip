import { describe, expect, it } from "vitest";
import { splitOwnerWaiting, type WaitingEntry } from "../src/merge.js";
import { routeToSeats, seatClassOf } from "../src/owner-seats.js";
import { parseDecisionRights } from "../src/decision-rights-model.js";

const NOW = new Date("2026-11-23T09:00:00.000Z");
const since = "2026-11-22T09:00:00.000Z";
const SEATS = { seo: "seat-seo-0001", social: "seat-social-01", planBusiness: "seat-plan-0001", other: "seat-other-001" };
const rights = parseDecisionRights({ decisionRights: { seats: SEATS, ownProducts: ["Velox", "Lumen Read"] } });
const row = (key: string, title: string, extra: Partial<WaitingEntry> = {}): WaitingEntry => ({ key, title, why: "why", kind: "judgement", source: "x", sourceTitle: "X", since, ...extra });
const filter = { activeAgentIds: Object.values(SEATS), hiddenIssueIds: [] as string[], rights };
const waits = (e: WaitingEntry) => splitOwnerWaiting([e], filter, NOW);

describe("PAR-13992 seat routing off the owner list", () => {
  it("1. autopilot SEO approvals and the learned-playbook batch wait on the seo seat", () => {
    for (const e of [row("seo:optimization:o1", "[AHS Law] Approve an SEO change: refresh the title"), row("seo:needs-you:s1:playbook_changes", "[Hunt and Gun] Keep or discard 6 learned SEO playbook changes", { kind: "review" })]) {
      const r = waits(e);
      expect(r.owner).toEqual([]);
      expect(r.others[0]!.waitsOn).toEqual({ kind: "agent", agentId: SEATS.seo });
    }
  });
  it("2. social experiments, playbook changes and campaign/social growth issues are NOT routed (safe autopilot refuses an agent)", () => {
    expect(waits(row("social:experiment:e1", "[Velox] Approve an experiment: evening posts")).owner).toHaveLength(1);
    expect(waits(row("social:playbook-change:c1", "Keep or discard a playbook change: x")).owner).toHaveLength(1);
    expect(waits(row("issue:i1", "PAR-13895 Approve campaign experiments and playbook changes (2026-W48)", { originKind: "plugin:partnersinbiz.campaigns" })).owner).toHaveLength(1);
    expect(waits(row("issue:i2", "PAR-13896 Approve social experiments and playbook changes (2026-W48)", { originKind: "plugin:partnersinbiz.social" })).owner).toHaveLength(1);
  });
  it("3. close-out and brief issues route to the other seat; the own-brand review-week issue to the social seat", () => {
    expect(seatClassOf(row("issue:a", "Close-out review: LWRC", { originKind: "plugin:partnersinbiz.cockpit:closeout" }))).toBe("other");
    expect(seatClassOf(row("issue:b", "Daily brief", { originKind: "plugin:partnersinbiz.cockpit:brief" }))).toBe("other");
    expect(waits(row("issue:c", "PAR-13908 Review social posts: week of 2026-11-23", { originKind: "plugin:partnersinbiz.social" })).others[0]!.waitsOn).toEqual({ kind: "agent", agentId: SEATS.social });
  });
  it("3b. other issues of those plugins stay with the owner: a client's post approval, a failed publish, a campaign send", () => {
    const social = "plugin:partnersinbiz.social";
    for (const [t, o] of [["[AHS Law] Approve or return social post: hello", social], ["Social post failed to publish", social], ["Social: act on the hook board", social], ["[AHS Law] Review social posts: week of 2026-11-23", social], ["Approve campaign send: Black Friday to 4,000 contacts", "plugin:partnersinbiz.campaigns"], ["[AHS Law] Approve campaign: newsletter", "plugin:partnersinbiz.campaigns"]] as const) {
      expect(waits(row("issue:x", t, { originKind: o })).owner, t).toHaveLength(1);
    }
  });
  it("4. own-brand post approvals wait on the social seat; a client's post stays with the owner", () => {
    expect(waits(row("social:review:p1", "Approve post: 20 minutes. Then a written plan")).owner).toEqual([]);
    expect(waits(row("social:review:p2", "[Velox] Approve post: 60 seconds on the clock")).others).toHaveLength(1);
    expect(waits(row("social:review:p3", "[AHS Law] Approve post: we did the filing")).owner).toHaveLength(1);
  });
  it("5. Studio dogfood approvals stay with the owner (only a person closing them grants the pib-browser approval, PAR-14783)", () => {
    const e = row("issue:d", 'PAR-11907 Approval: Toby clicks "Remove silences" (open dialog) on Studio dogfood edit (PAR-10184)', { originKind: "manual" });
    const r = waits(e);
    expect([r.owner.length, r.others.length]).toEqual([1, 0]);
  });
  it("5b. the same ask listed twice is one card (PAR-14783)", () => {
    const a = row("social:connect:1", "Connect Velox social accounts", { since: "2026-11-20T09:00:00.000Z" });
    const b = row("issue:x", "PAR-1 Connect Velox  social accounts");
    const r = splitOwnerWaiting([b, a, row("issue:y", "Save Velox test login")], filter, NOW);
    expect(r.owner.map((e) => e.key)).toEqual(["social:connect:1", "issue:y"]);
  });
  it("6. hard stops stay: a login, money or client-send title is never routed", () => {
    expect(routeToSeats([row("seo:optimization:o2", "Approve an SEO change: renew the SSL certificate and paste the API key")], rights)[0]!.waitsOn).toBeUndefined();
    expect(routeToSeats([row("issue:z", "Close-out review: send the invoice to the client", { originKind: "plugin:partnersinbiz.cockpit:closeout" })], rights)[0]!.waitsOn).toBeUndefined();
  });
  it("7. a row that already names who it waits on keeps that; a manual issue of another kind is untouched", () => {
    const named = row("seo:optimization:o3", "Approve an SEO change: x", { waitsOn: { kind: "client" } });
    expect(routeToSeats([named], rights)[0]!.waitsOn).toEqual({ kind: "client" });
    expect(routeToSeats([row("issue:m", "PAR-12505 Velox Spanish: decide reviewer source", { originKind: "manual" })], rights)[0]!.waitsOn).toBeUndefined();
  });
  it("8. no seats set, or routing off: everything stays with the owner; a class with no seat falls back to the other seat", () => {
    const e = row("seo:optimization:o4", "Approve an SEO change: x");
    expect(splitOwnerWaiting([e], { ...filter, rights: undefined }, NOW).owner).toHaveLength(1);
    expect(splitOwnerWaiting([e], { ...filter, rights: parseDecisionRights({ decisionRights: { enabled: false, seats: SEATS } }) }, NOW).owner).toHaveLength(1);
    const onlyOther = parseDecisionRights({ decisionRights: { seats: { other: SEATS.other } } });
    expect(routeToSeats([e], onlyOther)[0]!.waitsOn).toEqual({ kind: "agent", agentId: SEATS.other });
  });
  it("9. an inactive seat sends the row back to the owner; over 7 days it escalates to PiB, not the owner", () => {
    const e = row("seo:optimization:o5", "Approve an SEO change: x");
    expect(splitOwnerWaiting([e], { ...filter, activeAgentIds: [] }, NOW).owner).toHaveLength(1);
    const old = splitOwnerWaiting([{ ...e, since: "2026-11-10T09:00:00.000Z" }], filter, NOW);
    expect(old.owner).toEqual([]);
    expect(old.others[0]!.stale).toBe(true);
  });
});
