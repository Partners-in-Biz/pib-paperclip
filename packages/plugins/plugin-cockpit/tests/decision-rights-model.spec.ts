import { describe, expect, it } from "vitest";
import {
  askText,
  classify,
  DECISION_CLASSES,
  defaultAnswer,
  HARD_STOPS,
  largestRand,
  NO_DECISION_RIGHTS,
  parseDecisionRights,
  routeAsk,
  type DecisionRights,
} from "../src/decision-rights-model.js";

const MARCUS = "64b3cdda-afe4-499e-97d4-97f5dd492754";
const NOOR = "fa9b7a0a-2dd5-49af-9687-5306f815211e";
const PIB = "1433e737-e40f-4655-baff-d021a05b67bd";
const RHEA = "5c1b1944-5325-455c-b968-ae0971ea934b";
const STEVE = "f76be96b-bb8a-4899-a465-f0ef4b3131b0";
const SIPHO = "74e077e0-b5ef-478b-8f51-510713c696f0";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000d1";
const OWN = ["Velox", "Lumen", "partnersinbiz.online", "Slimwerk", "scrolledbrain", "Squadfolk", "JagGids", "PiB Platform", "pib-paperclip"];

/** The table the owner set on 11 Nov 2026, as the settings hold it. */
const RIGHTS: DecisionRights = {
  enabled: true,
  ownProducts: OWN,
  seats: { release: MARCUS, planTechnical: NOOR, planBusiness: PIB, access: PIB, social: RHEA, storeListing: STEVE, seo: RHEA, root: SIPHO, instructions: PIB, other: PIB },
};

const facts = (text: string, kind = "decision", extra: Partial<Parameters<typeof classify>[0]> = {}) => ({ kind, text, ...extra });
const stopOf = (text: string, kind = "decision", extra = {}) => classify(facts(text, kind, extra), OWN).hardStop;
const classOf = (text: string, kind = "decision", extra = {}) => {
  const read = classify(facts(text, kind, extra), OWN);
  return read.hardStop ? `STOP:${read.hardStop}` : read.decisionClass;
};

describe("hard stops: only these reach the owner", () => {
  it.each([
    // 1. client production
    ["AHS Law: merge client PR 54 to main (criminal lawyer pretoria refresh)?", "decision", "client-production"],
    ["Deploy the new checkout to the Hunt and Gun live site?", "decision", "client-production"],
    ["Run the migration on the client's production database?", "decision", "client-production"],
    // 2. money
    ["Send quote Q-HUN-001 to Hunt and Gun, R 6,860.00?", "decision", "money"],
    ["Buy the domain for R1,200?", "decision", "money"],
    ["Start a Resend subscription for the newsletter?", "decision", "money"],
    ["Approve the spend?", "money", "money"],
    ["Change the price of the Growth plan?", "decision", "money"],
    ["Pay $20 for the plugin licence?", "decision", "money"],
    // 3. logins, keys, devices
    ["Run firebase login --reauth on the box, or save the service account JSON as a company secret", "decision", "logins"],
    ["Install Lumen Read 1.7.2 from TestFlight on your iPhone and post the sign-in screenshots", "decision", "logins"],
    ["Connect the Partners in Biz LinkedIn company page so this week's posts can go there", "grant", "logins"],
    ["Paste the App Store Connect provider token", "info", "logins"],
    ["Who runs the staging payout re-test? It needs a WP admin login on the site", "decision", "logins"],
    ["Board sign-up is closed on the live server. Please tap Sign-up is closed in Setup so the health check clears.", "decision", "logins"],
    ["AWS SES access needed to restore DKIM", "decision", "logins"],
    ["Velox 1.0.7 licence-tester purchase: who can run it?", "decision", "logins"],
    ["Share the Drive folder with the service account as Editor, then accept", "decision", "logins"],
    ["Have you updated Cloud Console Data Access, recorded the demo video and replied to Google?", "decision", "logins"],
    // 4. legal or a client commitment
    ["Is the new privacy policy wording right?", "decision", "legal"],
    ["Approve the engagement letter", "legal", "legal"],
    ["Send the October report to the client now?", "decision", "legal"],
    ["Send the 11 approved pilot follow-ups today from the Mailbox drafts?", "decision", "legal"],
    ["A plan that changes the scope we promised the client: approve it?", "decision", "legal"],
    // 5. public store release
    ["Release Velox 1.0.8 to the App Store?", "decision", "store-release"],
    ["Submit the new version to Google Play for review?", "decision", "store-release"],
    // 6. deleting data
    ["Delete the old client records from the production database?", "decision", "data-delete"],
    ["Purge the customer backups older than a year?", "decision", "data-delete"],
  ])("%s -> %s", (text, kind, expected) => {
    expect(stopOf(text, kind)).toBe(expected);
  });

  it("a spend of R500 or less with no subscription, quote, invoice or price is not a hard stop", () => {
    expect(stopOf("Spend R450 on the Velox Google App campaign test?")).toBeNull();
    expect(stopOf("Spend R450 on the test?", "money")).toBeNull();
    expect(stopOf("Spend R501 on the test?")).toBe("money");
    expect(stopOf("A R99 per month tool?")).toBe("money");
  });

  it("reads rand amounts", () => {
    expect(largestRand("R 6,860.00 and R450")).toBe(6860);
    expect(largestRand("R1.5k cap")).toBe(1500);
    expect(largestRand("see PAR-7024 and PR 54")).toBeNull();
  });

  it("an effect always needs a person, and deleting a branch or a draft is not deleting data", () => {
    expect(stopOf("Give the mailbox agent read and draft access?", "decision", { hasEffect: true })).toBe("logins");
    expect(stopOf("Delete the stale worktrees and merged branches?")).toBeNull();
    expect(stopOf("Delete the draft and start again?")).toBeNull();
    // "Drop X for now" is not dropping data.
    expect(stopOf("Connect an X account for the brand, or drop X for now?")).toBe("logins");
    // Repo hygiene mentions merged branches: not a release to production.
    expect(classOf("Delete the stale worktrees and merged branches?")).toBe("release");
    expect(classOf("Merge PR 61 into development?")).toBe("release");
  });

  it("a hard stop the asker names stands when the words name none; the words win when they name one", () => {
    expect(classify(facts("Go ahead with option A?", "decision", { declaredHardStop: "client-production" }), OWN).hardStop).toBe("client-production");
    expect(classify(facts("Send the R 9,000 invoice?", "decision", { declaredHardStop: "legal" }), OWN).hardStop).toBe("money");
  });

  it("there are six, numbered as the owner numbered them", () => {
    expect(Object.values(HARD_STOPS).map((h) => h.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("classes: who decides what is not a hard stop", () => {
  it.each([
    ["Merge PR 539 for partnersinbiz.online into development? Vera passed it and CI is green.", "release"],
    ["Promote Velox development to main?", "release"],
    ["Deploy the Slimwerk Firebase functions and rules?", "release"],
    ["Plan sign-off: shared Paperclip API helper in pib-ops. Accept this plan?", "planTechnical"],
    ["Approve the Q1 marketing plan for our own brands?", "planBusiness"],
    ["Attach the stored secret VERCEL_TOKEN to the Delivery Lead seat?", "access"],
    ["Give Ren a plugin tool grant for seo-page-apply?", "access"],
    ["Approve this LinkedIn post for Partners in Biz?", "social"],
    ["New subtitle and keywords for the Velox App Store listing: use them?", "storeListing"],
    ["Apply the reviewed page refresh and internal links on the AHS Law site?", "seo"],
    ["Restart the worker with systemctl as root?", "root"],
    ["The off-site backup skipped /root/pib-ops. How should the size guard be fixed on the VPS?", "root"],

    ["Change the Operator's AGENTS.md to add the ladder rule?", "instructions"],
    ["Which of the two approaches should the Developer take?", "other"],
    ["Is the staging server the right place for the dry run?", "other"],
  ])("%s -> %s", (text, expected) => {
    expect(classOf(text)).toBe(expected);
  });

  it("what the table still sends to the owner stays a hard stop", () => {
    // A release that names none of our own products is treated as a client's.
    expect(classOf("Merge PR 54 to main?")).toBe("STOP:client-production");
    // The same release about a client, even one that names a product of ours.
    expect(classOf("Promote the Velox landing page to main?", "decision", { clientRef: "company:abc" })).toBe("STOP:client-production");
    // A post under a client's name.
    expect(classOf("Approve this LinkedIn post for the client?")).toBe("STOP:client-production");
    // A credential the company does not hold yet is a grant.
    expect(classOf("We need the xneelo hosting panel login", "grant")).toBe("STOP:logins");
    // Never payment or banking credentials, never the owner's personal logins.
    expect(classOf("Attach the stored secret for the bank payment account to the Bookkeeper?")).toMatch(/^STOP:/);
    expect(classOf("Attach the stored secret for the owner's personal Apple login to Max?")).toBe("STOP:logins");
    // Theme or plugin changes on a client site are not an SEO page refresh.
    expect(classOf("Deploy the theme change for Core Web Vitals on the Hunt and Gun site?")).toBe("STOP:client-production");
    // A store listing that carries a release is the release.
    expect(classOf("Update the App Store listing and release the new version?")).toBe("STOP:store-release");
  });
});

describe("routing at the moment the agent asks", () => {
  const ask = (text: string, asker: string | null = DEV, kind = "decision") => routeAsk(facts(text, kind), RIGHTS, asker);

  it("a hard stop goes to the owner", () => {
    expect(ask("Send quote Q-HUN-001 to Hunt and Gun, R 6,860.00?")).toEqual({ to: "owner", hardStop: "money", decisionClass: "other" });
  });

  it("a class in the table goes to its seat, never to the owner", () => {
    expect(ask("Promote Velox development to main?")).toMatchObject({ to: "seat", seatAgentId: MARCUS, decisionClass: "release", passedUp: false });
    expect(ask("Plan sign-off: accept this plan?")).toMatchObject({ to: "seat", seatAgentId: NOOR, decisionClass: "planTechnical" });
    expect(ask("Approve this LinkedIn post for Partners in Biz?")).toMatchObject({ to: "seat", seatAgentId: RHEA, decisionClass: "social" });
    expect(ask("New keywords for the Lumen App Store listing?")).toMatchObject({ to: "seat", seatAgentId: STEVE });
    expect(ask("Restart it with systemctl as root?")).toMatchObject({ to: "seat", seatAgentId: SIPHO });
  });

  it("anything else goes to the seat for `other`", () => {
    expect(ask("Which approach should I take?")).toMatchObject({ to: "seat", seatAgentId: PIB, decisionClass: "other" });
  });

  it("a decider who cannot decide its own class passes it to the last seat, not to the owner", () => {
    expect(ask("Promote Velox development to main?", MARCUS)).toMatchObject({ to: "seat", seatAgentId: PIB, decisionClass: "release", passedUp: true });
  });

  it("the last seat's own questions go to the owner; its questions in another seat's class go to that seat", () => {
    expect(ask("Which approach should we take?", PIB)).toEqual({ to: "owner", hardStop: null, decisionClass: "other" });
    expect(ask("Attach the stored secret VERCEL_TOKEN to Ren?", PIB)).toMatchObject({ to: "owner", decisionClass: "access" });
    expect(ask("Promote Velox development to main?", PIB)).toMatchObject({ to: "seat", seatAgentId: MARCUS });
  });

  it("a class with no seat falls back to `other`; a company with no seats asks the owner as before", () => {
    const partial: DecisionRights = { enabled: true, ownProducts: OWN, seats: { other: PIB } };
    expect(routeAsk(facts("Promote Velox development to main?"), partial, DEV)).toMatchObject({ to: "seat", seatAgentId: PIB, decisionClass: "release" });
    expect(routeAsk(facts("Which approach should I take?"), NO_DECISION_RIGHTS, DEV)).toEqual({ to: "owner", hardStop: null, decisionClass: "other" });
    expect(routeAsk(facts("Which approach should I take?"), { ...RIGHTS, enabled: false }, DEV)).toMatchObject({ to: "owner" });
  });
});

describe("settings", () => {
  it("reads seats as agent ids and drops anything malformed", () => {
    const rights = parseDecisionRights({ decisionRights: { ownProducts: ["Velox", " Lumen ", "", 7, "Velox"], seats: { release: MARCUS, other: PIB, seo: "Rhea", bogus: NOOR } } });
    expect(rights).toEqual({ enabled: true, ownProducts: ["Velox", "Lumen"], seats: { release: MARCUS, other: PIB } });
  });

  it("is off with no seats, when switched off, or when the settings hold nothing", () => {
    expect(parseDecisionRights({})).toEqual(NO_DECISION_RIGHTS);
    expect(parseDecisionRights({ decisionRights: { seats: {} } }).enabled).toBe(false);
    expect(parseDecisionRights({ decisionRights: { enabled: false, seats: { other: PIB } } }).enabled).toBe(false);
    expect(parseDecisionRights(null)).toEqual(NO_DECISION_RIGHTS);
  });

  it("every class of the table has a seat in the owner's table", () => {
    for (const key of DECISION_CLASSES) expect(RIGHTS.seats[key]).toBeTruthy();
  });
});

describe("the 24-hour default", () => {
  const base = { kind: "decision", options: ["Ship it", "Hold"], recommended: null as string | null, hasEffect: false, hardStop: null };

  it("is the recommended option, or the first one when none is marked", () => {
    expect(defaultAnswer(base)).toBe("Ship it");
    expect(defaultAnswer({ ...base, recommended: "Hold" })).toBe("Hold");
    expect(defaultAnswer({ ...base, kind: "info" })).toBe("Ship it");
  });

  it("is nothing for a hard stop, a money, legal or grant question, an effect, or a question with no options", () => {
    expect(defaultAnswer({ ...base, hardStop: "money" })).toBeNull();
    for (const kind of ["money", "legal", "grant"]) expect(defaultAnswer({ ...base, kind })).toBeNull();
    expect(defaultAnswer({ ...base, hasEffect: true })).toBeNull();
    expect(defaultAnswer({ ...base, options: [] })).toBeNull();
    expect(defaultAnswer({ ...base, recommended: "Something else" })).toBeNull();
  });
});

describe("askText", () => {
  it("joins what the asker wrote and drops hidden characters", () => {
    expect(askText({ question: "pass\u200Bword?", options: ["a"], why: "w", steps: ["s"] })).toBe("password?\na\nw\ns");
  });

  it("the issue title says which product it is about, never what the question is", () => {
    // The title names the product, the question does not.
    expect(classify({ kind: "decision", text: "Promote development to main?", context: "Velox: paywall copy" }, OWN)).toEqual({ hardStop: null, decisionClass: "release" });
    // A title full of release words does not turn a plain question into a release.
    expect(classify({ kind: "decision", text: "Which of the two approaches should I take?", context: "Ship the invoice page to production" }, OWN)).toEqual({ hardStop: null, decisionClass: "other" });
  });
});
