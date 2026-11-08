import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import plugin from "../src/worker.js";
import { withSignature, draftAttachments } from "../src/draft-edit.js";
import { CO } from "./helpers/memory.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const draftRow = (over: Row = {}): Row => ({
  id: "d1", company_id: CO, account_id: "acc-1", subject: "Re: Rebel Rags", body: "Hi Ellen,\nThanks.", direction: "outbound", status: "draft",
  to_addrs: [{ email: "ellen@example.com", name: null }], cc_addrs: [], bcc_addrs: [], draft: { html: "<p>Hi Ellen</p>", by: { kind: "agent", id: "agent-osm" } },
  send_error: null, created_at: "2026-10-20T08:00:00.000Z", ...over,
});

async function boot(messages: Row[]) {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      if (sql.includes(`FROM ${NAMESPACE}.messages WHERE company_id = $1 AND id = $2`)) return messages.filter((r) => r.id === params[1]);
      if (sql.includes(`FROM ${NAMESPACE}.crm_contacts`)) {
        return [{ id: "c1", name: "Ellen van Zyl", emails: ["ellenvanzyl12@gmail.com", "ellen@rebelrags.co.za"], account_ids: [] }];
      }
      if (sql.includes(`FROM ${NAMESPACE}.delegations WHERE account_id = $1 AND agent_id = $2`)) return [{ can_read: true, can_draft: true, can_send: false }];
      return [];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      executed.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  (harness.ctx as unknown as { db: typeof db }).db = db;
  await plugin.definition.setup(harness.ctx);
  const act = (key: string, params: Record<string, unknown>) => harness.performAction<Record<string, any>>(key, params, { companyId: CO, actor: { type: "user", userId: "user-peet" } } as never);
  return { harness, act, executed };
}

const update = (executed: Array<{ sql: string; params: unknown[] }>) => executed.find((e) => e.sql.includes(`UPDATE ${NAMESPACE}.messages SET subject`))!;

describe("a person edits a draft", () => {
  it("changes recipients, cc and bcc and the text, and drops the designed version when the text changes", async () => {
    const { act, executed } = await boot([draftRow()]);
    const out = await act("mailbox.update-draft", {
      messageId: "d1", to: [{ email: "a@b.co", name: "A" }], cc: "c@d.co; e@f.co", bcc: [], body: "New text", subject: "New subject",
    });
    expect(out).toEqual({ id: "d1", status: "draft", to: ["a@b.co"] });
    const row = update(executed);
    expect(row.params.slice(0, 4)).toEqual([CO, "d1", "New subject", "New text"]);
    expect(JSON.parse(row.params[5] as string).map((a: any) => a.email)).toEqual(["c@d.co", "e@f.co"]);
    expect(JSON.parse(row.params[7] as string).html).toBeNull();
  });

  it("keeps the designed version when only the recipients change", async () => {
    const { act, executed } = await boot([draftRow()]);
    await act("mailbox.update-draft", { messageId: "d1", to: "x@y.co" });
    expect(JSON.parse(update(executed).params[7] as string).html).toBe("<p>Hi Ellen</p>");
  });

  it("stores the signature choice and added files, and refuses a bad address or an oversized file", async () => {
    const { act, executed } = await boot([draftRow()]);
    await act("mailbox.update-draft", { messageId: "d1", useSignature: true, addFiles: [{ name: "q.pdf", mime: "application/pdf", data: Buffer.from("hello").toString("base64") }] });
    const saved = JSON.parse(update(executed).params[7] as string);
    expect(saved.useSignature).toBe(true);
    expect(saved.files).toHaveLength(1);
    expect(saved.files[0]).toMatchObject({ name: "q.pdf", mime: "application/pdf", bytes: 5 });
    await expect(act("mailbox.update-draft", { messageId: "d1", to: "not-an-address" })).rejects.toThrow(/Invalid to address/);
    await expect(act("mailbox.update-draft", { messageId: "d1", addFiles: [{ name: "big.bin", data: "A".repeat(12 * 1024 * 1024) }] })).rejects.toThrow(/larger than 7 MB/);
  });

  it("only a draft can be changed", async () => {
    const { act } = await boot([draftRow({ id: "d2", status: "sent" })]);
    await expect(act("mailbox.update-draft", { messageId: "d2", subject: "x" })).rejects.toThrow(/not been sent/);
    await expect(act("mailbox.update-draft", { messageId: "nope", subject: "x" })).rejects.toThrow(/not found/);
  });
});

describe("deleting and asking for a rewrite", () => {
  it("a deletion needs a reason, removes the draft, and tells the agent that wrote it", async () => {
    const { act, executed, harness } = await boot([draftRow()]);
    await expect(act("mailbox.delete-draft", { messageId: "d1", reason: " " })).rejects.toThrow(/Say why/);
    expect(await act("mailbox.delete-draft", { messageId: "d1", reason: "Wrong tone for a first contact" })).toEqual({ deleted: true, agentTold: true });
    expect(executed.some((e) => e.sql.includes(`DELETE FROM ${NAMESPACE}.messages`) && e.params[1] === "d1")).toBe(true);
    const issues = await harness.ctx.issues.list({ companyId: CO } as never);
    const issue = issues.find((i: any) => String(i.originId) === "mailbox:draft-deleted:d1") as any;
    expect(issue.assigneeAgentId).toBe("agent-osm");
    expect(issue.description).toContain("Wrong tone for a first contact");
    expect(issue.description).toContain("**Learned:**");
  });

  it("a rewrite request goes to the drafting agent with the note and the draft id, and marks the draft", async () => {
    const { act, executed, harness } = await boot([draftRow()]);
    const out = await act("mailbox.request-rewrite", { messageId: "d1", note: "Shorter and friendlier" });
    expect(out).toMatchObject({ id: "d1", agentTold: true });
    const saved = JSON.parse(update(executed).params[7] as string);
    expect(saved.rewrite.note).toBe("Shorter and friendlier");
    const issues = await harness.ctx.issues.list({ companyId: CO } as never);
    const issue = issues.find((i: any) => String(i.originId).startsWith("mailbox:draft-rewrite:d1")) as any;
    expect(issue.description).toContain("`d1`");
    expect(issue.description).toContain("update-draft");
  });

  it("a draft a person wrote has nobody to ask for a rewrite", async () => {
    const { act } = await boot([draftRow({ draft: { by: { kind: "user", id: "user-peet" } } })]);
    await expect(act("mailbox.request-rewrite", { messageId: "d1", note: "Shorter" })).rejects.toThrow(/nobody to ask/);
  });
});

describe("recipient search", () => {
  it("answers one hit per matching address and nothing for a single letter", async () => {
    const { act } = await boot([]);
    expect(await act("mailbox.contact-search", { q: "e" })).toEqual({ contacts: [] });
    const out = await act("mailbox.contact-search", { q: "rebelrags" });
    expect(out.contacts).toEqual([{ id: "c1", name: "Ellen van Zyl", email: "ellen@rebelrags.co.za" }]);
  });
});

describe("signature and files on send", () => {
  it("adds the signature to a plain draft as HTML and text", () => {
    const out = withSignature({ text: "Hi Ellen", html: null }, { html: "<b>Peet</b><br>PiB", text: "Peet\nPiB" });
    expect(out.html).toContain("white-space:pre-wrap");
    expect(out.html).toContain('class="gmail_signature"');
    expect(out.text).toBe("Hi Ellen\n\n-- \nPeet\nPiB");
  });

  it("puts the signature inside a designed version's body, and leaves a mail alone when Gmail has no signature", () => {
    expect(withSignature({ text: "t", html: "<html><body><p>x</p></body></html>" }, { html: "<i>S</i>", text: "S" }).html).toMatch(/<p>x<\/p><br><div class="gmail_signature"[^>]*><i>S<\/i><\/div><\/body>/);
    expect(withSignature({ text: "t", html: null }, { html: "", text: "" })).toEqual({ text: "t", html: null });
  });

  it("turns a draft's stored files into mail attachments", () => {
    const [file] = draftAttachments({ files: [{ id: "f1", name: "q.pdf", mime: "application/pdf", bytes: 5, data: Buffer.from("hello").toString("base64") }] });
    expect(file!.filename).toBe("q.pdf");
    expect(Buffer.from(file!.content).toString()).toBe("hello");
  });
});

describe("a person's own draft", () => {
  it("is deleted without a reason; an agent's draft still needs one", async () => {
    const own = await boot([draftRow({ id: "d2", draft: { by: { kind: "user", id: "u1" } } })]);
    await expect(own.act("mailbox.delete-draft", { messageId: "d2" })).resolves.toMatchObject({ deleted: true, agentTold: false });
    const agents = await boot([draftRow()]);
    await expect(agents.act("mailbox.delete-draft", { messageId: "d1" })).rejects.toThrow(/Say why/);
  });
});
