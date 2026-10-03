/**
 * 0.8.0 (Q10-13, POPIA): the CRM sends an approved erasure; Social wipes the person from its inbox data. Their comments and
 * messages become tombstones (so the next poll does not bring them back), the Jev decisions and the queued lead hand-offs for
 * them are deleted, and what Social cannot or may not erase is reported as retained, never skipped silently.
 */
import { describe, expect, it, vi } from "vitest";
import { handleEraseRequest, type ContactEraseRequested } from "@partnersinbiz/pib-plugin-kit";
import { ERASED_LINE, ERASED_TEXT, eraseSubject, matchKeys, scrubDigestText } from "../src/erasure.js";
import { replyQueueSteps } from "../src/triage.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx } from "./helpers.js";

const T = (name: string) => `${NAMESPACE}.${name}`;

const request = (subject: ContactEraseRequested["subject"], extra: Partial<ContactEraseRequested> = {}): ContactEraseRequested => ({
  key: "erase:r1", requestId: "r1", subject, scope: "all", reason: "data_subject_request", approvedByUserId: "owner-1", requestedAt: "2026-10-03T08:00:00Z", source: "partnersinbiz.crm", ...extra,
});

interface Item { id: string; author: string; body: string; reply_body?: string | null; triage_issue_id?: string | null; erased?: boolean }

interface IssueDef { originId: string; description: string; truncated?: boolean }

/** The issue text the plugin writes for one reply-queue item (triage.ts `itemLine`). */
const digestLine = (author: string, quote: string, id: string) => `- **${author}** (comment, question, neutral): "${quote}" — [open](https://x.test/c/${id}) · itemId \`${id}\``;

/** A reply-queue digest as triage.ts writes it: header, one line per item, scope line and the agent's steps. */
function digestText(lines: string[]): string {
  return ["These LinkedIn · Acme Page comments and messages need a reply (2026-10-03; sorted by the built-in rules). More arriving today are added here as comments.", "", ...lines, "", "Scope: own work (PiB's own accounts). Call the Social tools without a client.", "", ...replyQueueSteps()].join("\n");
}

function world(opts: { items?: Item[]; leads?: Array<{ key: string; contactId: string }>; approvals?: Array<{ id: string; post_id: string; recipient_email: string }>; postsMentioning?: number; failIssue?: boolean; issues?: Record<string, IssueDef> } = {}) {
  const items = opts.items ?? [];
  const decisions: string[] = [];
  const outbox = (opts.leads ?? []).map((l) => ({ ...l }));
  const approvals = (opts.approvals ?? []).map((a) => ({ ...a, cleared: false }));
  const issueUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const issues = opts.issues ?? {};
  const state = { failIssue: Boolean(opts.failIssue) };
  const ctx = fakeCtx(
    {
      issues: {
        // The host returns the issue as it is now: an update changes what the next read sees.
        get: vi.fn(async (id: string) => (issues[id] ? { id, originId: issues[id]!.originId, description: issues[id]!.description, descriptionTruncated: issues[id]!.truncated } : null)),
        update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          if (state.failIssue) throw new Error("host refused");
          issueUpdates.push({ id, patch });
          if (issues[id] && typeof patch.description === "string") issues[id]!.description = patch.description;
          return { id };
        }),
      },
      logger: { info: (message: string) => void logs.push(message), warn: () => undefined, error: () => undefined, debug: () => undefined },
    },
    {
      queryResult: (sql, params) => {
        if (sql.includes(`FROM ${T("outbox")}`) && sql.includes("result->>'contactId'")) {
          return outbox.filter((o) => o.contactId === params[1]).map((o) => ({ key: o.key }));
        }
        if (sql.includes(`FROM ${T("inbox_items")}`) && sql.includes("id = ANY(")) {
          const ids = JSON.parse(String(params[1])) as string[];
          return items.filter((i) => ids.includes(i.id) && !i.erased).map((i) => ({ id: i.id, triage_issue_id: i.triage_issue_id ?? null }));
        }
        if (sql.includes(`FROM ${T("inbox_items")}`) && sql.includes("position($2 in lower(body))")) {
          return items.filter((i) => !i.erased && [i.body, i.author, i.reply_body ?? ""].some((t) => t.toLowerCase().includes(String(params[1])))).map((i) => ({ id: i.id, triage_issue_id: i.triage_issue_id ?? null }));
        }
        if (sql.includes(`FROM ${T("inbox_items")}`) && sql.includes("regexp_replace(body")) {
          return items.filter((i) => !i.erased && (i.body + i.author).replace(/[^0-9]/g, "").includes(String(params[1]))).map((i) => ({ id: i.id, triage_issue_id: i.triage_issue_id ?? null }));
        }
        if (sql.includes(`FROM ${T("client_approvals")}`) && sql.includes("lower(recipient_email) = $2")) return approvals.filter((a) => a.recipient_email === params[1]).map((a) => ({ id: a.id, post_id: a.post_id }));
        if (sql.includes(`FROM ${T("posts")}`) && sql.includes("count(*)")) return [{ n: String(opts.postsMentioning ?? 0) }];
        return [];
      },
      executeResult: (sql, params) => {
        if (sql.startsWith(`UPDATE ${T("inbox_items")}`)) {
          const ids = JSON.parse(String(params[1])) as string[];
          let n = 0;
          for (const item of items) if (ids.includes(item.id) && !item.erased) ((item.author = ERASED_TEXT), (item.body = ERASED_TEXT), (item.reply_body = null), (item.erased = true), (n += 1));
          return n;
        }
        if (sql.startsWith(`DELETE FROM ${T("decisions")}`)) {
          const ids = JSON.parse(String(params[1])) as string[];
          decisions.push(...ids);
          return ids.length;
        }
        if (sql.startsWith(`DELETE FROM ${T("outbox")}`)) {
          const keys = JSON.parse(String(params[1])) as string[];
          let n = 0;
          for (let i = outbox.length - 1; i >= 0; i -= 1) if (keys.includes(outbox[i]!.key)) (outbox.splice(i, 1), (n += 1));
          return n;
        }
        if (sql.startsWith(`UPDATE ${T("client_approvals")}`)) {
          const ids = JSON.parse(String(params[1])) as string[];
          let n = 0;
          for (const a of approvals) if (ids.includes(a.id)) ((a.cleared = true), (n += 1));
          return n;
        }
        if (sql.startsWith(`UPDATE ${T("review_outcomes")}`)) return JSON.parse(String(params[1])).length;
        return 0;
      },
    },
  );
  return { ctx, items, decisions, outbox, approvals, issueUpdates, logs, issues, state };
}

describe("what identifies a person", () => {
  it("an email is lower-cased, a phone is its last nine digits (so +27 and 0 forms both match, and fewer than eight never do), and nothing is guessed", () => {
    expect(matchKeys({ email: " Sam@Acme.TEST ", phone: "+27 82 555 0100", contactId: "k1" })).toEqual({ email: "sam@acme.test", phone: "825550100", contactId: "k1" });
    expect(matchKeys({ phone: "082 555 0100" }).phone).toBe("825550100");
    expect(matchKeys({ phone: "5550100" }).phone).toBeNull();
    expect(matchKeys({ email: "not-an-email", phone: "12345", contactId: "" })).toEqual({ email: null, phone: null, contactId: null });
    expect(matchKeys({})).toEqual({ email: null, phone: null, contactId: null });
  });
});

describe("erasing a person from Social", () => {
  it("makes their inbox items tombstones, deletes the decisions and lead hand-offs, scrubs the escalation issue, and reports what stays", async () => {
    const w = world({
      items: [
        { id: "i1", author: "Sam Jones", body: "Call me on 082 555 0100 about a quote", triage_issue_id: "iss-esc" },
        { id: "i2", author: "@someone", body: "Email sam@acme.test please" },
        { id: "i3", author: "@bystander", body: "Great post!" },
        { id: "i4", author: "@samj", body: "Interested in your prices" },
      ],
      leads: [{ key: "social:inbox:i4", contactId: "k1" }, { key: "social:inbox:i3", contactId: "someone-else" }],
      issues: { "iss-esc": { originId: "inbox-escalate:i1", description: "Jev thinks it may carry risk.\n\n> Call me on 082 555 0100 about a quote\n\nFrom: Sam Jones\nitemId: `i1`" } },
    });
    const out = await eraseSubject(w.ctx, request({ email: "Sam@Acme.test", phone: "+27 82 555 0100", contactId: "k1" }), "co");
    // i1 (phone), i2 (email) and i4 (the CRM's answer to its lead named this contact) are theirs; i3 is not.
    expect(out.counts).toEqual({ inbox_items: 3, decisions: 3, lead_handoffs: 1, issue_texts: 1 });
    expect(w.items.map((i) => [i.id, i.body])).toEqual([["i1", ERASED_TEXT], ["i2", ERASED_TEXT], ["i3", "Great post!"], ["i4", ERASED_TEXT]]);
    expect(w.items.find((i) => i.id === "i1")!.author).toBe(ERASED_TEXT);
    expect(w.decisions.sort()).toEqual(["i1", "i2", "i4"]);
    expect(w.outbox).toEqual([{ key: "social:inbox:i3", contactId: "someone-else" }]);
    expect(w.issueUpdates).toEqual([{ id: "iss-esc", patch: { description: expect.stringContaining("Removed") } }]);
    expect(out.retained?.map((r) => r.what)).toEqual(["The original comments and messages on the social platforms", "Comments on the reply-queue and escalation issues that quoted the comments"]);
    expect(out.errors).toBeUndefined();
  });

  it("is idempotent: a second run finds nothing left, and the tombstone keeps the platform's comment id so the poll cannot bring it back", async () => {
    const w = world({ items: [{ id: "i2", author: "@someone", body: "Email sam@acme.test please" }] });
    const subject = { email: "sam@acme.test" };
    expect((await eraseSubject(w.ctx, request(subject), "co")).counts.inbox_items).toBe(1);
    expect(await eraseSubject(w.ctx, request(subject), "co")).toEqual({ counts: {} });
    const update = w.ctx.fakeDb.executes.find((e) => e.sql.startsWith(`UPDATE ${T("inbox_items")}`))!;
    // The row stays (external_id and account_id are not touched), only the words go.
    expect(update.sql).not.toMatch(/external_id|account_id\s*=/);
    expect(update.sql).toContain(`author = '${ERASED_TEXT}'`);
    expect(update.sql).toContain("reply_draft = NULL");
    expect(update.sql).toContain("permalink = NULL");
    expect(update.sql).toContain("triage = NULL");
  });

  it("every statement is for this company, and the matching never uses LIKE (an underscore in an email is not a wildcard)", async () => {
    const w = world({ items: [{ id: "i1", author: "a", body: "mail sam_x@acme.test" }, { id: "i2", author: "b", body: "mail samAx@acme.test" }] });
    await eraseSubject(w.ctx, request({ email: "sam_x@acme.test" }), "co");
    expect(w.items.map((i) => i.erased ?? false)).toEqual([true, false]);
    for (const q of w.ctx.fakeDb.queries) expect(q.params[0]).toBe("co");
    for (const e of w.ctx.fakeDb.executes) expect(e.params[0] === "co" || e.sql.includes("company_id = $1")).toBe(true);
    expect(w.ctx.fakeDb.queries.some((q) => /\blike\b/i.test(q.sql) && !q.sql.includes("'social:inbox:%'"))).toBe(false);
  });

  it("clears the client approval records that name them (the email a link was for, the name they typed, their note)", async () => {
    const w = world({ approvals: [{ id: "ap1", post_id: "p1", recipient_email: "sam@acme.test" }, { id: "ap2", post_id: "p2", recipient_email: "other@acme.test" }] });
    const out = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(out.counts).toEqual({ client_approvals: 1, review_outcomes: 1 });
    expect(w.approvals.map((a) => a.cleared)).toEqual([true, false]);
    const sql = w.ctx.fakeDb.executes.find((e) => e.sql.startsWith(`UPDATE ${T("client_approvals")}`))!.sql;
    expect(sql).toContain("recipient_email = NULL");
    expect(sql).toContain("answer_note = NULL");
    // The approval itself stays, anonymously: it is the record that the post was approved.
    expect(sql).not.toMatch(/status\s*=|content_hash|snapshot/);
  });

  it("reports published posts that quote the person instead of rewriting the client's content", async () => {
    const w = world({ postsMentioning: 2 });
    const out = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(out.counts).toEqual({});
    expect(out.retained).toEqual([{ what: "2 posts whose text mentions the person's email or phone", why: expect.stringContaining("client's published content") }]);
  });

  it("a marketing-only erasure has nothing here, and a subject with no identifier is left alone", async () => {
    const w = world({ items: [{ id: "i1", author: "a", body: "sam@acme.test" }] });
    expect(await eraseSubject(w.ctx, request({ email: "sam@acme.test" }, { scope: "marketing_only" }), "co")).toEqual({ counts: {}, retained: [] });
    expect(await eraseSubject(w.ctx, request({ clientRef: "c1", clientKind: "company" }), "co")).toEqual({ counts: {}, retained: [] });
    expect(w.items[0]!.erased).toBeUndefined();
    expect(w.ctx.fakeDb.executes).toEqual([]);
  });

  it("an issue the host will not rewrite is reported, its items are kept so the next run finds them, and the retry finishes the job", async () => {
    const w = world({
      items: [{ id: "i1", author: "a", body: "sam@acme.test", triage_issue_id: "iss-esc" }, { id: "i2", author: "b", body: "again sam@acme.test" }],
      issues: { "iss-esc": { originId: "inbox-escalate:i1", description: "> sam@acme.test\nitemId: `i1`" } },
      failIssue: true,
    });
    const out = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    // i2 has no issue and is erased; i1 stays as it was (its text is how the retry finds it), and the error says so.
    expect(out.counts.inbox_items).toBe(1);
    expect(w.items.map((i) => [i.id, i.erased ?? false])).toEqual([["i1", false], ["i2", true]]);
    expect(out.errors).toEqual(["issue iss-esc could not be cleaned (host refused); its items are kept until the next run"]);
    expect(w.outbox).toEqual([]);
    // The host recovers: the retry cleans the issue and then erases the item.
    w.state.failIssue = false;
    const retry = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(retry.errors).toBeUndefined();
    expect(retry.counts).toMatchObject({ inbox_items: 1, issue_texts: 1 });
    expect(w.items.every((i) => i.erased)).toBe(true);
    expect(w.issues["iss-esc"]!.description).toContain("Removed");
  });
});

describe("the daily reply-queue digest is shared: only the erased person's lines go", () => {
  const sam = digestLine("Sam Jones", "Call me on 082 555 0100 about a quote", "i1");
  const other = digestLine("Pat Other", "What are your opening hours?", "i5");
  const third = digestLine("Lee Third", "Do you ship to Durban?", "i6");

  it("replaces the erased item's line and keeps the other people's lines, the header, the scope line and every step", async () => {
    const original = digestText([sam, other, third]);
    const w = world({
      items: [
        { id: "i1", author: "Sam Jones", body: "Call me on 082 555 0100 about a quote", triage_issue_id: "iss-dig" },
        { id: "i5", author: "Pat Other", body: "What are your opening hours?", triage_issue_id: "iss-dig" },
        { id: "i6", author: "Lee Third", body: "Do you ship to Durban?", triage_issue_id: "iss-dig" },
      ],
      issues: { "iss-dig": { originId: "inbox:a1:2026-10-03", description: original } },
    });
    const out = await eraseSubject(w.ctx, request({ phone: "+27 82 555 0100" }), "co");
    expect(out.counts).toEqual({ inbox_items: 1, decisions: 1, issue_texts: 1, digest_lines: 1 });
    const after = w.issues["iss-dig"]!.description;
    expect(after).toBe(original.replace(sam, ERASED_LINE));
    // The other two people's lines and all of the agent's steps are exactly as they were.
    expect(after).toContain(other);
    expect(after).toContain(third);
    for (const step of replyQueueSteps()) expect(after).toContain(step);
    expect(after).not.toContain("Sam Jones");
    expect(after).not.toContain("082 555 0100");
    expect(after).not.toContain("itemId `i1`");
    // The digest was not blanked: it is not the whole-text rewrite an escalation gets.
    expect(after).not.toContain("Removed:");
    expect(w.items.map((i) => i.erased ?? false)).toEqual([true, false, false]);
    // Digest comments cannot be edited by a plugin: reported, not skipped.
    expect(out.retained?.map((r) => r.why).join(" ")).toContain("N more to reply to");
  });

  it("two erased people in one digest are both removed in one rewrite, and a second run changes nothing", async () => {
    const w = world({
      items: [
        { id: "i1", author: "Sam Jones", body: "mail sam@acme.test", triage_issue_id: "iss-dig" },
        { id: "i2", author: "Sam again", body: "also sam@acme.test", triage_issue_id: "iss-dig" },
        { id: "i5", author: "Pat Other", body: "What are your opening hours?", triage_issue_id: "iss-dig" },
      ],
      issues: { "iss-dig": { originId: "inbox:a1:2026-10-03", description: digestText([digestLine("Sam Jones", "mail sam@acme.test", "i1"), digestLine("Pat Other", "What are your opening hours?", "i5"), digestLine("Sam again", "also sam@acme.test", "i2")]) } },
    });
    const first = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(first.counts).toMatchObject({ inbox_items: 2, issue_texts: 1, digest_lines: 2 });
    expect(w.issueUpdates).toHaveLength(1);
    const text = w.issues["iss-dig"]!.description!;
    expect(text.split("\n").filter((l) => l === ERASED_LINE)).toHaveLength(2);
    expect(text).toContain("Pat Other");
    const second = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(second.counts).toEqual({});
    expect(w.issueUpdates).toHaveLength(1);
  });

  it("a digest that has nothing of theirs on it is not written at all, and an issue that is gone is not an error", async () => {
    const w = world({
      items: [{ id: "i1", author: "Sam", body: "sam@acme.test", triage_issue_id: "iss-dig" }, { id: "i2", author: "Sam", body: "sam@acme.test again", triage_issue_id: "iss-gone" }],
      issues: { "iss-dig": { originId: "inbox:a1:2026-10-03", description: digestText([digestLine("Pat Other", "Hello", "i5")]) } },
    });
    const out = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(w.issueUpdates).toEqual([]);
    expect(out.errors).toBeUndefined();
    expect(out.counts).toEqual({ inbox_items: 2, decisions: 2 });
  });

  it("a digest the host shortened is never written back (that would cut the issue off), and the items are kept for the retry", async () => {
    const w = world({
      items: [{ id: "i1", author: "Sam Jones", body: "mail sam@acme.test", triage_issue_id: "iss-dig" }],
      issues: { "iss-dig": { originId: "inbox:a1:2026-10-03", description: digestText([digestLine("Sam Jones", "mail sam@acme.test", "i1")]), truncated: true } },
    });
    const out = await eraseSubject(w.ctx, request({ email: "sam@acme.test" }), "co");
    expect(w.issueUpdates).toEqual([]);
    expect(out.errors?.[0]).toContain("shortened by the host");
    expect(w.items[0]!.erased).toBeUndefined();
  });

  it("scrubDigestText matches only the line that ENDS with the item id: a comment that quotes an id in its text is not mistaken for it", () => {
    const tricky = digestLine("Eve", 'my id is itemId `i1` ok', "i9");
    const text = ["header", digestLine("Sam", "hi", "i1"), tricky, "1. step mentions itemId `i1` in the middle of a line"].join("\n");
    const out = scrubDigestText(text, ["i1"]);
    expect(out.lines).toBe(1);
    expect(out.text.split("\n")).toEqual(["header", ERASED_LINE, tricky, "1. step mentions itemId `i1` in the middle of a line"]);
    expect(scrubDigestText(text, []).text).toBe(text);
  });
});

describe("through the kit's receiver", () => {
  it("never erases without a person's approval, and answers once per request", async () => {
    const w = world({ items: [{ id: "i1", author: "a", body: "sam@acme.test" }] });
    const state = new Map<string, unknown>();
    const ctx = Object.assign(w.ctx, { state: { get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null, set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v), delete: async () => undefined } });
    const options = { plugin: "partnersinbiz.social", erase: (r: ContactEraseRequested, companyId: string) => eraseSubject(ctx, r, companyId) };
    const refused = await handleEraseRequest(ctx, options, "co", request({ email: "sam@acme.test" }, { approvedByUserId: "" }));
    expect(refused).toMatchObject({ status: "failed", plugin: "partnersinbiz.social" });
    expect(w.items[0]!.erased).toBeUndefined();
    const done = await handleEraseRequest(ctx, options, "co", request({ email: "sam@acme.test" }));
    expect(done).toMatchObject({ status: "erased", counts: { inbox_items: 1 }, plugin: "partnersinbiz.social" });
    // Sent again (the CRM re-announces until every plugin answers): the stored answer comes back, nothing runs twice.
    const executesBefore = w.ctx.fakeDb.executes.length;
    expect(await handleEraseRequest(ctx, options, "co", request({ email: "sam@acme.test" }))).toMatchObject({ status: "erased" });
    expect(w.ctx.fakeDb.executes.length).toBe(executesBefore);
  });
});
