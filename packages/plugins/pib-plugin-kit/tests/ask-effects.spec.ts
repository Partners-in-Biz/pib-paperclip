import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_EVENTS,
  ASKING_SECTION,
  askAnsweredKey,
  askCardProblems,
  askEffectComment,
  askEffectKeys,
  asAnswered,
  checkEffectParams,
  classifyAskAnswer,
  clearAskEffects,
  describeAskEffect,
  emitAskAnswered,
  installAskEffects,
  isIssueLink,
  registerAskEffect,
  registerAskEffectResults,
  runAskEffect,
  type AskAnswered,
  type AskEffectResult,
} from "../src/index.js";
import { fakeCtx } from "./helpers/fake-ctx.js";

const OPTIONS = ["Grant the Operator read and draft on the mailbox", "Read only", "No"];
const ask = (patch: Partial<AskAnswered> = {}): AskAnswered => ({
  key: askAnsweredKey("ask-1", "2026-10-03T08:00:00.000Z"),
  askId: "ask-1",
  issueId: "issue-9",
  kind: "grant",
  effect: { key: "mailbox.delegate", params: { accountId: "acc-1", agentId: "op", scope: "read+draft" } },
  question: "May the Operator read and draft on the mailbox?",
  options: OPTIONS,
  answer: "Yes",
  answeredByUserId: "owner",
  answeredAt: "2026-10-03T08:00:00.000Z",
  returnAgentId: "op",
  ...patch,
});

beforeEach(() => clearAskEffects());

describe("reading the owner's answer", () => {
  it.each([
    ["Yes", "approve"],
    ["yes please, go ahead", "approve"],
    ["Approved.", "approve"],
    ["1", "approve"],
    ["option 1", "approve"],
    ["Grant the Operator read and draft on the mailbox", "approve"],
    ["No", "decline"],
    ["no thanks", "decline"],
    ["Don't do that", "decline"],
    ["No problem, go ahead", "approve"],
    ["no worries", "approve"],
    ["No problem with the first, but not the second", "unclear"],
    ["yes, send too", "unclear"],
    ["go ahead with sending as well", "unclear"],
    ["yes and also give it to Steve", "unclear"],
    ["yes but only read", "unclear"],
    ["maybe later", "unclear"],
    ["2", "unclear"],
    ["Read only", "unclear"],
    ["", "unclear"],
  ])("%j -> %s", (answer, decision) => {
    expect(classifyAskAnswer(answer, OPTIONS).decision).toBe(decision);
  });

  it("says which option was picked", () => {
    expect(classifyAskAnswer("2", OPTIONS)).toEqual({ decision: "unclear", optionIndex: 1 });
    expect(classifyAskAnswer("3", OPTIONS)).toEqual({ decision: "decline", optionIndex: 2 });
    expect(classifyAskAnswer("Yes", OPTIONS).optionIndex).toBeNull();
  });
});

describe("running an effect", () => {
  it("applies it once, checks it really happened, and replays the stored result", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "The Operator can now read and draft on acc-1." }));
    const verify = vi.fn(async () => true);
    registerAskEffect("mailbox.delegate", { apply, verify });
    const first = await runAskEffect(fake.ctx, "co-1", ask());
    expect(first).toMatchObject({ status: "applied", verified: true, effectKey: "mailbox.delegate", askId: "ask-1", detail: "The Operator can now read and draft on acc-1." });
    const again = await runAskEffect(fake.ctx, "co-1", ask());
    expect(again!.status).toBe("already_applied");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("passes the handler the params, the decision and the company", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async (input: { companyId: string; ask: AskAnswered; decision: string }) => ({ detail: `${input.companyId}:${input.ask.effect.params?.scope}:${input.decision}` }));
    registerAskEffect("mailbox.delegate", apply);
    expect((await runAskEffect(fake.ctx, "co-1", ask()))!.detail).toBe("co-1:read+draft:approve");
  });

  it("does not call it applied when reading it back says no, and tries again next time", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "Created the delegation." }));
    let present = false;
    registerAskEffect("mailbox.delegate", { apply, verify: async () => ({ ok: present, detail: "the delegation is not there" }) });
    const failed = await runAskEffect(fake.ctx, "co-1", ask());
    expect(failed).toMatchObject({ status: "failed", verified: false });
    expect(failed!.detail).toContain("did not confirm it: the delegation is not there");
    present = true;
    expect((await runAskEffect(fake.ctx, "co-1", ask()))!.status).toBe("applied");
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("reports a thrown error without leaking a stack, and retries later", async () => {
    const fake = fakeCtx();
    registerAskEffect("mailbox.delegate", async () => {
      throw new Error("Gmail said no\n    at secret/path.js:1");
    });
    const result = await runAskEffect(fake.ctx, "co-1", ask());
    expect(result!.status).toBe("failed");
    expect(result!.detail).toContain("Could not apply it: Gmail said no");
    expect(result!.detail).not.toContain("\n");
    registerAskEffect("mailbox.delegate", async () => ({ detail: "done now" }));
    expect((await runAskEffect(fake.ctx, "co-1", ask()))!.status).toBe("applied");
  });

  it("does nothing for a decline or an unclear answer, and says so", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "x" }));
    registerAskEffect("mailbox.delegate", apply);
    expect(await runAskEffect(fake.ctx, "co-1", ask({ answer: "No" }))).toMatchObject({ status: "declined" });
    expect(await runAskEffect(fake.ctx, "co-1", ask({ key: "second-answer", answer: "yes but only read" }))).toMatchObject({ status: "unclear" });
    expect(apply).not.toHaveBeenCalled();
    // A decision the effect asks to see runs it.
    registerAskEffect("mailbox.delegate", { apply, runOn: ["approve", "decline"] });
    await runAskEffect(fake.ctx, "co-1", ask({ key: "other", answer: "No" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("returns null for an effect another plugin owns", async () => {
    expect(await runAskEffect(fakeCtx().ctx, "co-1", ask({ effect: { key: "seo.unknown" } }))).toBeNull();
    registerAskEffect("a.b", async () => ({ detail: "x" }));
    expect(askEffectKeys()).toEqual(["a.b"]);
  });

  it("is a new run for a corrected answer", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "ok" }));
    registerAskEffect("mailbox.delegate", apply);
    await runAskEffect(fake.ctx, "co-1", ask({ answer: "No" }));
    await runAskEffect(fake.ctx, "co-1", ask({ key: askAnsweredKey("ask-1", "2026-10-03T09:00:00.000Z"), answer: "Yes, do it" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("an effect needs a person behind the answer (it can be a permission grant the agent chose)", () => {
  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["the board sentinel", "local-board"],
    ["the asking agent itself", "op"],
  ])("refuses an answer from %s and never calls the handler", async (_label, who) => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "granted" }));
    registerAskEffect("mailbox.delegate", apply);
    const result = await runAskEffect(fake.ctx, "co-1", ask({ answeredByUserId: who as never }));
    expect(result).toMatchObject({ status: "refused", verified: false });
    expect(result!.detail).toContain("no person behind it");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not remember a refusal, so the same ask answered by a real user applies", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "granted" }));
    registerAskEffect("mailbox.delegate", apply);
    expect((await runAskEffect(fake.ctx, "co-1", ask({ answeredByUserId: null as never })))!.status).toBe("refused");
    expect((await runAskEffect(fake.ctx, "co-1", ask({ answeredByUserId: "user-peet" })))!.status).toBe("applied");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not replay a stored result for an answer that has no person behind it", async () => {
    const fake = fakeCtx();
    registerAskEffect("mailbox.delegate", async () => ({ detail: "granted" }));
    expect((await runAskEffect(fake.ctx, "co-1", ask()))!.status).toBe("applied");
    expect((await runAskEffect(fake.ctx, "co-1", ask({ answeredByUserId: "local-board" })))!.status).toBe("refused");
  });

  it("a handler can refuse params it does not allow; nothing is applied or stored", async () => {
    const fake = fakeCtx();
    const apply = vi.fn(async () => ({ detail: "granted" }));
    let allowed = false;
    registerAskEffect("mailbox.delegate", { apply, validate: ({ ask: a }) => (allowed ? null : `agent ${a.effect.params?.agentId} is not in this company`) });
    const refused = await runAskEffect(fake.ctx, "co-1", ask());
    expect(refused).toMatchObject({ status: "refused", detail: "Nothing was changed: agent op is not in this company." });
    expect(apply).not.toHaveBeenCalled();
    allowed = true;
    expect((await runAskEffect(fake.ctx, "co-1", ask()))!.status).toBe("applied");
    registerAskEffect("mailbox.delegate", { apply, validate: () => { throw new Error("db down"); } });
    expect((await runAskEffect(fake.ctx, "co-1", ask({ key: "other" })))).toMatchObject({ status: "refused" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("through the event: an unattributed answer gets a refused result (so the Cockpit stops re-announcing) and no handler call", async () => {
    const mailbox = fakeCtx({ manifestId: "partnersinbiz.mailbox" });
    const apply = vi.fn(async () => ({ detail: "granted" }));
    registerAskEffect("mailbox.delegate", apply);
    installAskEffects(mailbox.ctx);
    const name = `plugin.partnersinbiz.cockpit.${ASK_EVENTS.answered}`;
    await mailbox.deliver(name, "co-1", ask({ answeredByUserId: null as never }));
    await mailbox.deliver(name, "co-1", { ...ask(), answeredByUserId: undefined });
    await mailbox.deliver(name, "co-1", ask({ answeredByUserId: "local-board" }));
    expect(apply).not.toHaveBeenCalled();
    expect(mailbox.emitted.map((e) => (e.payload as unknown as AskEffectResult).status)).toEqual(["refused", "refused", "refused"]);
    // another plugin's effect, or a payload too broken to name the ask, is not answered
    await mailbox.deliver(name, "co-1", ask({ answeredByUserId: null as never, effect: { key: "seo.other" } }));
    await mailbox.deliver(name, "co-1", { nonsense: true });
    expect(mailbox.emitted).toHaveLength(3);
  });

  it("asAnswered rejects a payload without who answered", () => {
    expect(asAnswered(ask())).toMatchObject({ answeredByUserId: "owner" });
    expect(asAnswered({ ...ask(), answeredByUserId: null })).toBeNull();
    expect(asAnswered({ ...ask(), answeredByUserId: "  " })).toBeNull();
    expect(asAnswered({ ...ask(), answeredByUserId: undefined })).toBeNull();
  });

  it("whitelists agent-supplied params: unknown keys, wrong types and values outside the list are problems", () => {
    const rules = { accountId: { required: true, type: "string" as const, pattern: /^[a-z0-9-]+$/ }, agentId: { required: true, type: "string" as const }, scope: { required: true, oneOf: ["read", "read+draft"] as const } };
    expect(checkEffectParams({ accountId: "acc-1", agentId: "op", scope: "read+draft" }, rules)).toEqual({ ok: true, params: { accountId: "acc-1", agentId: "op", scope: "read+draft" } });
    const bad = checkEffectParams({ accountId: "ACC 1", agentId: "op", scope: "send", admin: true }, rules);
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { problems: string[] }).problems).toEqual(expect.arrayContaining(['"admin" is not a parameter this effect accepts', '"accountId" is not in the expected form', '"scope" must be one of read, read+draft']));
    expect(checkEffectParams({}, rules)).toMatchObject({ ok: false, problems: ['"accountId" is required', '"agentId" is required', '"scope" is required'] });
    expect(checkEffectParams({ a: 1 }, { a: { type: "string" } })).toMatchObject({ ok: false });
  });

  it("describes the effect so the card the owner answers shows what it will do", () => {
    expect(describeAskEffect({ key: "mailbox.delegate", params: { accountId: "acc-1", agentId: "op", scope: "read+draft" } })).toBe("Runs mailbox.delegate with accountId=acc-1, agentId=op, scope=read+draft when you say yes.");
    expect(describeAskEffect({ key: "x.y" })).toBe("Runs x.y when you say yes.");
  });
});

describe("the event loop between the Cockpit and a plugin", () => {
  it("answers an `ask.answered` with an `ask.effect.result`, once, even when it is delivered twice", async () => {
    const mailbox = fakeCtx({ manifestId: "partnersinbiz.mailbox" });
    const apply = vi.fn(async () => ({ detail: "Operator delegated on acc-1 (read, draft)." }));
    registerAskEffect("mailbox.delegate", { apply, verify: async () => true });
    installAskEffects(mailbox.ctx);
    await mailbox.deliver(`plugin.partnersinbiz.cockpit.${ASK_EVENTS.answered}`, "co-1", ask());
    await mailbox.deliver(`plugin.partnersinbiz.cockpit.${ASK_EVENTS.answered}`, "co-1", ask());
    expect(apply).toHaveBeenCalledTimes(1);
    expect(mailbox.emitted.map((e) => [e.name, (e.payload as unknown as AskEffectResult).status])).toEqual([[ASK_EVENTS.effectResult, "applied"], [ASK_EVENTS.effectResult, "already_applied"]]);
    expect((mailbox.emitted[0]!.payload as unknown as AskEffectResult).plugin).toBe("partnersinbiz.mailbox");
  });

  it("ignores asks without an effect, another plugin's effect and malformed payloads", async () => {
    const fake = fakeCtx();
    registerAskEffect("mailbox.delegate", async () => ({ detail: "x" }));
    installAskEffects(fake.ctx);
    const name = `plugin.partnersinbiz.cockpit.${ASK_EVENTS.answered}`;
    await fake.deliver(name, "co-1", { ...ask(), effect: undefined });
    await fake.deliver(name, "co-1", ask({ effect: { key: "seo.other" } }));
    await fake.deliver(name, "co-1", { nonsense: true });
    expect(fake.emitted).toEqual([]);
  });

  it("lets the Cockpit send an answered ask and receive every plugin's result", async () => {
    const cockpit = fakeCtx();
    await emitAskAnswered(cockpit.ctx, "co-1", ask());
    expect(cockpit.emitted[0]).toMatchObject({ name: ASK_EVENTS.answered, companyId: "co-1" });
    const seen: Array<[string, string]> = [];
    registerAskEffectResults(cockpit.ctx, async (companyId, result) => void seen.push([companyId, result.status]));
    const result: AskEffectResult = { key: "k", askId: "ask-1", effectKey: "mailbox.delegate", plugin: "partnersinbiz.mailbox", status: "applied", detail: "done", verified: true, at: "2026-10-03T08:01:00.000Z" };
    await cockpit.deliver(`plugin.partnersinbiz.mailbox.${ASK_EVENTS.effectResult}`, "co-1", result);
    await cockpit.deliver(`plugin.partnersinbiz.mailbox.${ASK_EVENTS.effectResult}`, "co-1", { bad: true });
    expect(seen).toEqual([["co-1", "applied"]]);
  });

  it("words what was applied for the blocked issue", () => {
    const base: AskEffectResult = { key: "k", askId: "a", effectKey: "e", plugin: "p", status: "applied", detail: "The Operator can now draft.", verified: true, at: "" };
    expect(askEffectComment(base)).toContain("**Applied and checked:** The Operator can now draft.");
    expect(askEffectComment({ ...base, status: "declined", detail: "The owner declined." })).toContain("**Not applied:**");
    expect(askEffectComment({ ...base, status: "failed", detail: "Gmail said no." })).toContain("Do not ask again");
    expect(askEffectComment({ ...base, status: "failed", detail: "Gmail said no." })).not.toContain("has been told");
    expect(askEffectComment({ ...base, status: "refused", detail: "Nothing was changed: no person." })).toContain("ask again");
  });
});

describe("what every ask card must carry", () => {
  const link = { label: "Mailbox settings", href: "/PAR/mailbox?tab=delegations" };

  it("needs a deep link, and a grant needs the screen and the steps", () => {
    expect(askCardProblems({ kind: "decision", links: [] })[0]).toContain("Add at least one link");
    expect(askCardProblems({ kind: "decision", links: [{ label: "Issue", href: "/PAR/issues/PAR-12" }] })).toEqual([]);
    const issueOnly = askCardProblems({ kind: "grant", links: [{ label: "Issue", href: "/PAR/issues/PAR-12" }], steps: ["Open it"] });
    expect(issueOnly[0]).toContain("must link the exact screen");
    expect(askCardProblems({ kind: "grant", links: [link], steps: [] })[0]).toContain("needs steps");
    expect(askCardProblems({ kind: "grant", links: [link], steps: ["Open Mailbox", "Click Grant"] })).toEqual([]);
  });

  it("limits an effect to a grant or a decision", () => {
    expect(askCardProblems({ kind: "money", links: [link], effect: { key: "x.y" } }).join(" ")).toContain("is a grant or a decision");
    expect(askCardProblems({ kind: "decision", links: [link], effect: { key: "x.y" } })).toEqual([]);
  });

  it("tells an issue link from a screen link", () => {
    expect(isIssueLink("/PAR/issues/PAR-12")).toBe(true);
    expect(isIssueLink("/PAR/issues/PAR-12?tab=x#c")).toBe(true);
    expect(isIssueLink("/PAR/mailbox")).toBe(false);
    expect(isIssueLink("https://console.cloud.google.com/apis")).toBe(false);
  });

  it("asks agents to state what unblocks a block, inside the size guard", () => {
    expect(ASKING_SECTION).toContain("unblockDescriptor");
    expect(ASKING_SECTION).toContain("escalated after 24 h");
    expect(ASKING_SECTION.length).toBeLessThan(1000);
  });
});
