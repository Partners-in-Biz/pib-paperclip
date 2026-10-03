/**
 * An email an agent sends by hand (issue delivery, or after a failed automatic send)
 * carries the same footer as an automatic one: who sent it, how to opt out and the
 * person's own unsubscribe link. The skill tells agents not to write their own
 * opt-out line, so the step issue must already carry it.
 */
import { describe, expect, it } from "vitest";
import { checkUnsubscribeToken } from "../src/links.js";
import { boot, campaign, CO, contact, enrollment, PAST, PUBLIC_URL, seed, step, UI_BASE } from "./helpers/harness.js";
import type { Store } from "./helpers/fake-db.js";

const ORIGIN = "plugin:partnersinbiz.campaigns";

function store(): Store {
  const s = seed();
  s.crm_contacts = [
    contact("ada", "Ada Lovelace", ["Ada@Acme.test"], { account_ids: ["acme"] }),
    contact("carl", "Carl NoMail", []),
  ];
  s.campaigns!.push(
    campaign("camp-own", { delivery: "issue", from_name: "" }),
    campaign("camp-acme", { delivery: "issue", client_kind: "company", client_ref: "acme", client_name: "Acme Plumbing" }),
    campaign("camp-auto", { delivery: "email" }),
  );
  for (const id of ["camp-own", "camp-acme", "camp-auto"]) s.campaign_steps!.push(step(id, 1, "a", "Hello {{first_name|there}}", "Hi {{first_name|there}}, we help {{company|your business}}.\n\nCan we talk?"));
  return s;
}

async function stepIssue(booted: Awaited<ReturnType<typeof boot>>, enrollmentId: string) {
  await booted.harness.runJob("open-due-steps");
  const issues = await booted.harness.ctx.issues.list({ companyId: CO, originKind: ORIGIN });
  return issues.find((issue) => issue.originId === `campaigns:step:${enrollmentId}:1`);
}

/** The unsubscribe link in a text, and what its signed token says. */
async function linkIn(ctx: Awaited<ReturnType<typeof boot>>["harness"]["ctx"], text: string) {
  const match = /unsubscribe here: (\S+) or reply STOP/.exec(text);
  if (!match) return null;
  expect(match[1]!.startsWith(`${PUBLIC_URL}${UI_BASE}unsubscribe.html?t=`)).toBe(true);
  const token = decodeURIComponent(new URL(match[1]!).searchParams.get("t")!);
  return checkUnsubscribeToken(ctx, token);
}

describe("a step issue for an agent to send by hand", () => {
  it("carries the footer and this person's own unsubscribe link, so the agent does not have to write an opt-out", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada", { next_due_at: PAST }));
    const booted = await boot({ store: s });
    const issue = await stepIssue(booted, "e-own");
    expect(issue).toBeTruthy();
    expect(issue!.title).toBe("Hello Ada: Ada Lovelace");
    const description = issue!.description!;
    // The body for this person, then the footer, then the instruction to send it whole.
    expect(description).toContain("Hi Ada, we help Acme Plumbing.\n\nCan we talk?\n\n--\nYou are getting this email from Partners in Biz. To stop getting these emails, unsubscribe here: ");
    expect(description).toMatch(/or reply STOP\.\n\nSend to: Ada Lovelace <ada@acme\.test>/i);
    expect(description).toContain("including the last lines that say who we are and how to unsubscribe: never cut them");
    // The link is the one only this person on this list can use.
    expect(await linkIn(booted.harness.ctx, description)).toMatchObject({ companyId: CO, email: "ada@acme.test", senderKey: "own" });
  });

  it("names the client as the sender and unsubscribes from the client's list only", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-acme", "camp-acme", "ada", { next_due_at: PAST }));
    const booted = await boot({ store: s });
    const issue = await stepIssue(booted, "e-acme");
    expect(issue!.title).toBe("[Acme Plumbing] Hello Ada: Ada Lovelace");
    expect(issue!.description).toContain("You are getting this email from Acme Plumbing. To stop getting these emails, unsubscribe here: ");
    expect(issue!.description).not.toContain("from Partners in Biz");
    expect(await linkIn(booted.harness.ctx, issue!.description!)).toMatchObject({ email: "ada@acme.test", senderKey: "company:acme" });
  });

  it("still says how to opt out when no link can be built (no public address): reply STOP", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-own", "camp-own", "ada", { next_due_at: PAST }));
    const booted = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    const issue = await stepIssue(booted, "e-own");
    expect(issue!.description).toContain("\n\n--\nYou are getting this email from Partners in Biz. To stop getting these emails, reply STOP.");
    expect(issue!.description).not.toContain("unsubscribe here");
  });

  it("a contact with no email address still gets the footer text (the issue says to reach them another way)", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-carl", "camp-own", "carl", { next_due_at: PAST }));
    const booted = await boot({ store: s });
    const issue = await stepIssue(booted, "e-carl");
    expect(issue!.description).toContain("To stop getting these emails, reply STOP.");
    expect(issue!.description).not.toContain("Send to:");
  });
});

describe("a failed automatic send handed to an agent", () => {
  it("carries the same footer and link as the email the plugin would have sent", async () => {
    const s = store();
    s.campaign_enrollments!.push(enrollment("e-f", "camp-auto", "ada", { sending_key: "campaigns:step:e-f:1", next_due_at: PAST }));
    s.outbox!.push({ key: "campaigns:step:e-f:1", company_id: CO, event: "mail.send.requested", payload: {}, status: "failed", attempts: 20, last_error: "Gmail not connected", result: null });
    const booted = await boot({ store: s });
    await booted.harness.runJob("redeliver-mail");
    const issue = (await booted.harness.ctx.issues.list({ companyId: CO, originKind: ORIGIN })).find((i) => i.originId === "campaigns:send-failed:e-f:1");
    expect(issue).toBeTruthy();
    const description = issue!.description!;
    expect(description).toContain("Gmail not connected");
    expect(description).toContain("**Subject:** Hello Ada");
    expect(description).toContain("Hi Ada, we help Acme Plumbing.\n\nCan we talk?\n\n--\nYou are getting this email from Partners in Biz.");
    expect(description).toContain("including the last lines that say who we are and how to unsubscribe");
    expect(await linkIn(booted.harness.ctx, description)).toMatchObject({ email: "ada@acme.test", senderKey: "own" });
  });
});

describe("the approval for an issue-delivery campaign", () => {
  it("says the step issues carry the footer, and warns when no unsubscribe link can be built", async () => {
    const s = store();
    s.campaigns![0] = { ...s.campaigns![0]!, status: "draft", owner_user_id: "user-peet" };
    const booted = await boot({ store: s, config: { timezone: "Africa/Johannesburg" } });
    const asked = await booted.harness.executeTool<{ data?: { approvalIssueId: string; warnings: string[] }; error?: string }>("request-campaign-approval", { campaignId: "camp-own" }, { companyId: CO, agentId: "agent-camp" });
    expect(asked.error).toBeUndefined();
    const description = (await booted.harness.ctx.issues.get(asked.data!.approvalIssueId, CO))!.description!;
    expect(description).toContain("**Added to every step issue:** the same footer (who sent it, the person's own unsubscribe link");
    expect(description).not.toContain("**Added to every email:**");
    expect(asked.data!.warnings.some((w) => /step issues will end with "reply STOP" only/.test(w))).toBe(true);
  });
});
