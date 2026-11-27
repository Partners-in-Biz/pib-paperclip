import { describe, expect, it } from "vitest";
import {
  agentMay,
  agentMayCreateIn,
  agentMaySetMode,
  CAMPAIGN_AGENT_ACTIONS,
  CAMPAIGN_MODE_LABELS,
  CAMPAIGN_MODES,
  DEFAULT_CAMPAIGN_MODE,
  parseCampaignMode,
  type AgentMayDecision,
  type CampaignAgentAction,
  type CampaignMode,
  type CampaignScope,
} from "../src/index.js";

// Plan PAR-9192 rev. 2, section 5.2, written out cell by cell. Scopes: own (to leads), own reaching current clients (Q7), client.
// Short forms: person / owner = refused, that one acts; "+yes" = the client's written yes first; propose = agent proposes,
// that one approves; yes:<condition> = allowed once the caller checks the condition.
type Scope = "own" | "reach" | "client";
const SCOPES: Record<Scope, CampaignScope> = {
  own: { isClient: false, reachesClients: false },
  reach: { isClient: false, reachesClients: true },
  client: { isClient: true, reachesClients: false },
};
type Row = Record<CampaignMode, Record<Scope, string>>;
const all = (v: string): Record<Scope, string> => ({ own: v, reach: v, client: v });
const launchApprover = { own: "person", reach: "owner", client: "owner+yes" };

const TABLE: Record<CampaignAgentAction, Row> = {
  "read-results": { off: all("no"), safe: all("yes"), full: all("yes") },
  "edit-draft": { off: all("no"), safe: all("yes"), full: all("yes") },
  "first-launch": { off: launchApprover, safe: launchApprover, full: launchApprover },
  "launch-paused": { off: all("person"), safe: all("person"), full: all("person") },
  "resume-own-pause": { off: all("person"), safe: all("person"), full: all("yes") },
  "resume-other-pause": { off: all("person"), safe: all("person"), full: all("person") },
  "enroll-launched": { off: all("person"), safe: all("person"), full: all("person") },
  "enroll-draft": { off: all("no"), safe: all("yes"), full: all("yes") },
  "declare-winner": { off: all("person"), safe: all("person"), full: all("yes:significance") },
  "add-running-variant": {
    off: all("no"),
    safe: { own: "propose-person", reach: "propose-owner", client: "propose-owner+yes" },
    full: { own: "yes:variant-limits", reach: "owner", client: "owner+yes" },
  },
  complete: { off: all("person"), safe: all("person"), full: all("yes:all-enrollments-finished") },
  stop: { off: all("yes"), safe: all("yes"), full: all("yes") },
  "change-launched": { off: all("no"), safe: all("no"), full: all("no") },
  "raise-mode": { off: all("person"), safe: all("person"), full: all("person") },
  "playbook-change": { off: all("growth-lab"), safe: all("growth-lab"), full: all("growth-lab") },
};

function short(d: AgentMayDecision): string {
  const who = `${d.approver ?? ""}${d.clientYes ? "+yes" : ""}`;
  switch (d.verdict) {
    case "yes":
      return d.condition ? `yes:${d.condition}` : "yes";
    case "person":
      return who;
    case "propose":
      return `propose-${who}`;
    default:
      return d.verdict;
  }
}

describe("agentMay: the rule table of plan 5.2", () => {
  it("covers every action, and only those", () => {
    expect([...CAMPAIGN_AGENT_ACTIONS].sort()).toEqual(Object.keys(TABLE).sort());
  });

  for (const action of CAMPAIGN_AGENT_ACTIONS) {
    for (const mode of CAMPAIGN_MODES) {
      for (const scope of Object.keys(SCOPES) as Scope[]) {
        const expected = TABLE[action][mode][scope];
        it(`${action} in ${mode}, ${scope}: ${expected}`, () => {
          const d = agentMay(mode, action, SCOPES[scope]);
          expect(short(d)).toBe(expected);
          expect(d.allowed).toBe(d.verdict === "yes");
          expect(d.mode).toBe(mode);
          expect(d.action).toBe(action);
          if (d.verdict === "yes") expect(d.reason).toBe("");
          else expect(d.reason.length).toBeGreaterThan(20);
        });
      }
    }
  }

  it("a client campaign stays client even when the audience also reaches clients", () => {
    expect(short(agentMay("full", "first-launch", { isClient: true, reachesClients: true }))).toBe("owner+yes");
    expect(short(agentMay("full", "add-running-variant", { isClient: true, reachesClients: true }))).toBe("owner+yes");
  });

  it("refusals tell the agent who acts and where", () => {
    expect(agentMay("safe", "first-launch", SCOPES.client).reason).toBe(
      "An agent may not launch this campaign in Safe mode. Say so on the campaign's task; the company owner does it on the campaign screen, after the client's written yes is recorded on the campaign.",
    );
    expect(agentMay("full", "enroll-launched", SCOPES.own).reason).toContain("a person does it on the campaign screen");
    expect(agentMay("off", "edit-draft", SCOPES.own).reason).toContain("in Off mode");
    expect(agentMay("safe", "add-running-variant", SCOPES.own).reason).toContain("may only propose");
  });

  it("reads an unknown mode as Off and refuses an unknown action", () => {
    expect(agentMay("auto" as CampaignMode, "edit-draft", SCOPES.own)).toMatchObject({ mode: "off", verdict: "no", allowed: false });
    expect(agentMay(undefined as unknown as CampaignMode, "stop", SCOPES.own).allowed).toBe(true);
    expect(() => agentMay("safe", "send-now" as CampaignAgentAction, SCOPES.own)).toThrow(/unknown campaign action/);
  });
});

describe("campaign mode rules", () => {
  it("has three modes, Safe by default, Auto as the label for full", () => {
    expect(CAMPAIGN_MODES).toEqual(["off", "safe", "full"]);
    expect(DEFAULT_CAMPAIGN_MODE).toBe("safe");
    expect(CAMPAIGN_MODE_LABELS).toEqual({ off: "Off", safe: "Safe", full: "Auto" });
    expect(parseCampaignMode("full")).toBe("full");
    expect(parseCampaignMode("auto")).toBeNull();
    expect(parseCampaignMode(null)).toBeNull();
  });

  it("an agent may keep or lower a mode, never raise it", () => {
    const allowed: Array<[CampaignMode, CampaignMode]> = [
      ["full", "full"], ["full", "safe"], ["full", "off"], ["safe", "safe"], ["safe", "off"], ["off", "off"],
    ];
    const refused: Array<[CampaignMode, CampaignMode]> = [["off", "safe"], ["off", "full"], ["safe", "full"]];
    for (const [from, to] of allowed) expect(agentMaySetMode(from, to), `${from} to ${to}`).toEqual({ allowed: true, reason: "" });
    for (const [from, to] of refused) {
      const r = agentMaySetMode(from, to);
      expect(r.allowed, `${from} to ${to}`).toBe(false);
      expect(r.reason).toContain("lower a campaign's mode but not raise it");
    }
    expect(agentMaySetMode("safe", "auto" as CampaignMode).allowed).toBe(false);
    // An unreadable current mode counts as Off: nothing above it.
    expect(agentMaySetMode("bogus" as CampaignMode, "safe").allowed).toBe(false);
  });

  it("an agent cannot create a campaign in full", () => {
    expect(agentMayCreateIn("off").allowed).toBe(true);
    expect(agentMayCreateIn("safe").allowed).toBe(true);
    const r = agentMayCreateIn("full");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("cannot create a campaign in Auto mode");
    expect(agentMayCreateIn("auto" as CampaignMode).allowed).toBe(false);
  });
});
