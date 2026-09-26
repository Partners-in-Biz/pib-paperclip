import { describe, expect, it } from "vitest";
import { MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { runSyncJob, syncAccount, type SyncStats } from "../src/gmail/sync.js";
import { CO } from "./helpers/memory.js";
import { jevAnswers } from "./helpers/fake-gmail.js";
import { JEV_CONFIG, setup } from "./helpers/setup.js";

const received = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === MAIL_EVENTS.received);

describe("sync-mailbox", () => {
  it("does a 7-day resync without a cursor: metadata only, stores rows, sets the cursor, emits new mail", async () => {
    const { gmail, store, env, account, loaded, run, host } = setup();
    gmail.addMessage({ id: "m1", headers: { From: "Ann <ann@client.co.za>", To: "peet@partnersinbiz.online", Subject: "Website quote?", "Message-ID": "<m1@client.co.za>" }, snippet: "Can you quote us for a new site?" });
    gmail.addMessage({
      id: "m2",
      headers: { From: "accounts@supplier.co.za", To: "peet@partnersinbiz.online", Subject: "Invoice 881", "Content-Type": "multipart/mixed; boundary=x" },
      snippet: "Please find attached",
      payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", data: "secret body" }, { mimeType: "application/pdf", filename: "INV-881.pdf", attachmentId: "att-1", size: 5120 }] },
    });
    gmail.addMessage({ id: "m3", labelIds: ["SENT"], headers: { From: "peet@partnersinbiz.online", To: "x@y.co", Subject: "Sent by me" } });
    gmail.addMessage({ id: "m4", labelIds: ["DRAFT"], headers: { From: "peet@partnersinbiz.online", Subject: "Draft" } });

    const stats = (await syncAccount(env, await loaded(), account, await run())) as SyncStats;
    expect(stats.mode).toBe("full");
    expect(stats.stored).toBe(3);
    expect(stats.triaged).toBe(2);
    expect(store.accounts.get("acc-1")!.history_id).toBe(String(gmail.historyId));

    // Headers via format=metadata; attachment names via the parts-only mask; never a full body.
    const gets = gmail.calls.filter((c) => c.method === "GET" && /\/messages\/m\d$/.test(c.url.pathname));
    expect(gets.every((c) => c.url.searchParams.get("format") === "metadata" || c.url.searchParams.has("fields"))).toBe(true);
    expect(gets.find((c) => c.url.searchParams.has("fields"))?.url.pathname).toMatch(/m2$/);
    expect(gets.find((c) => c.url.searchParams.get("format") === "metadata")!.url.searchParams.getAll("metadataHeaders")).toContain("In-Reply-To");

    const m2 = store.messages.get("gm_acc-1_m2")!;
    expect(m2.attachments).toEqual([{ attachmentId: "att-1", filename: "INV-881.pdf", mime: "application/pdf", bytes: 5120 }]);
    expect(JSON.stringify(m2)).not.toContain("secret body");
    expect(store.messages.get("gm_acc-1_m3")!.direction).toBe("outbound");
    expect(store.messages.has("gm_acc-1_m4")).toBe(false);
    const m1 = store.messages.get("gm_acc-1_m1")!;
    expect(m1.from_addr).toEqual({ email: "ann@client.co.za", name: "Ann" });
    expect(m1.rfc_message_id).toBe("<m1@client.co.za>");
    expect(m1.read_at).toBeNull();

    const events = received(host.emitted);
    expect(events.map((e) => e.payload.key).sort()).toEqual(["mail:m1", "mail:m2"]);
    const payload = events.find((e) => e.payload.key === "mail:m2")!.payload;
    expect(payload).toMatchObject({ accountAddress: gmail.email, messageId: "m2", threadId: "t-m2", subject: "Invoice 881", triage: { category: "invoice_or_bill" } });
    expect(host.emitted.every((e) => e.companyId === CO)).toBe(true);
  });

  it("follows history from the cursor: fetches only new messages, applies label changes, moves the cursor", async () => {
    const { gmail, store, env, account, loaded, run } = setup();
    gmail.addMessage({ id: "old", headers: { From: "a@b.co", Subject: "Old" } });
    await syncAccount(env, await loaded(), account, await run());
    const cursor = store.accounts.get("acc-1")!.history_id;
    gmail.calls.length = 0;

    gmail.addMessage({ id: "new", headers: { From: "c@d.co", Subject: "New one" } });
    gmail.changeLabels("old", ["INBOX"]); // read in Gmail
    const again = { ...store.accounts.get("acc-1")! };
    const stats = (await syncAccount(env, await loaded(), again, await run())) as SyncStats;

    expect(stats.mode).toBe("history");
    expect(gmail.calls.find((c) => c.url.pathname.endsWith("/history"))!.url.searchParams.get("startHistoryId")).toBe(cursor);
    expect(gmail.count("GET", "/profile")).toBe(0);
    expect(gmail.calls.filter((c) => /\/messages\/old$/.test(c.url.pathname))).toHaveLength(0);
    expect(stats.stored).toBe(1);
    expect(stats.labelUpdates).toBe(1);
    expect(store.messages.get("gm_acc-1_old")!.read_at).not.toBeNull();
    expect(store.accounts.get("acc-1")!.history_id).toBe(String(gmail.historyId));
  });

  it("resyncs the last 7 days when Gmail says the cursor expired (404)", async () => {
    const { gmail, store, env, account, loaded, run } = setup();
    account.history_id = "5";
    store.accounts.get("acc-1")!.history_id = "5";
    gmail.minHistoryId = 900;
    gmail.addMessage({ id: "x1", headers: { From: "a@b.co", Subject: "Hello" } });
    const stats = (await syncAccount(env, await loaded(), account, await run())) as SyncStats;
    expect(stats.mode).toBe("full");
    expect(gmail.count("GET", "/profile")).toBe(1);
    expect(gmail.calls.find((c) => c.url.pathname.endsWith("/messages") && c.method === "GET")!.url.searchParams.get("q")).toContain("newer_than:7d");
    expect(stats.stored).toBe(1);
    expect(store.accounts.get("acc-1")!.history_id).toBe(String(gmail.historyId));
  });

  it("re-emits the last 30 minutes on every run with the same keys", async () => {
    const { gmail, env, account, loaded, run, host, store } = setup();
    gmail.addMessage({ id: "r1", headers: { From: "ann@client.co.za", Subject: "Question" } });
    await syncAccount(env, await loaded(), account, await run());
    const first = received(host.emitted).map((e) => e.payload.key);
    await syncAccount(env, await loaded(), { ...store.accounts.get("acc-1")! }, await run());
    const all = received(host.emitted).map((e) => e.payload.key);
    expect(first).toEqual(["mail:r1"]);
    expect(all).toEqual(["mail:r1", "mail:r1"]);
  });

  it("creates PiB labels once and applies them in one batch per label", async () => {
    const { gmail, env, account, loaded, run, store } = setup();
    gmail.addMessage({ id: "p1", headers: { From: "ann@client.co.za", Subject: "Proof of payment INV-7" } });
    gmail.addMessage({ id: "p2", headers: { From: "bob@client.co.za", Subject: "Remittance advice" } });
    await syncAccount(env, await loaded(), account, await run());
    expect(gmail.labels.map((l) => l.name)).toEqual(expect.arrayContaining(["PiB", "PiB/POP"]));
    const batches = gmail.calls.filter((c) => c.url.pathname.endsWith("/batchModify"));
    expect(batches).toHaveLength(1);
    expect(JSON.parse(batches[0]!.body!).ids.sort()).toEqual(["p1", "p2"]);
    expect(gmail.messages.get("p1")!.labelIds).toContain(store.accounts.get("acc-1")!.label_ids!["PiB/POP"]);
    // Cached: a second run does not create labels again.
    gmail.addMessage({ id: "p3", headers: { From: "c@client.co.za", Subject: "POP attached" } });
    await syncAccount(env, await loaded(), { ...store.accounts.get("acc-1")! }, await run());
    expect(gmail.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/labels"))).toHaveLength(2);
  });

  it("skips a locked account and companies whose settings were never saved", async () => {
    const { env, account, loaded, run, store, gmail, host } = setup();
    store.locks.add("acc-1");
    expect(await syncAccount(env, await loaded(), account, await run())).toEqual({ skipped: expect.any(String) });
    store.locks.clear();
    (host.ctx.config as { get: () => Promise<unknown> }).get = async () => ({});
    gmail.addMessage({ id: "z", headers: { From: "a@b.co", Subject: "x" } });
    expect(await runSyncJob(env)).toEqual({ accounts: 1, synced: 0, failed: 0 });
    expect(gmail.calls).toHaveLength(0);
  });

  it("opens one reply issue per thread when an assignee is set", async () => {
    const { gmail, env, host, store, loaded, run, account } = setup({ ...JEV_CONFIG, triageIssueAssignee: "agent-42" });
    gmail.jevResponse = jevAnswers({
      category: { type: "choice", choice: "lead", probabilities: { lead: 0.92 }, confidence: 0.92 },
      urgency: { type: "score", score: 1.4, probabilities: { "1": 0.6, "2": 0.4 }, confidence: 0.6 },
      needs_reply: { type: "noul", noul: 0.95 },
      phishing: { type: "noul", noul: 0.01 },
    });
    gmail.addMessage({ id: "q1", threadId: "th-1", headers: { From: "new@prospect.co.za", Subject: "Quote for a website?" }, snippet: "We are interested in a new site" });
    await syncAccount(env, await loaded(), account, await run());
    gmail.addMessage({ id: "q2", threadId: "th-1", headers: { From: "new@prospect.co.za", Subject: "Re: Quote for a website?" }, snippet: "Following up on pricing" });
    await syncAccount(env, await loaded(), { ...store.accounts.get("acc-1")! }, await run());
    const issues = [...host.issues.values()];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ assigneeAgentId: "agent-42", status: "todo", originKind: "plugin:partnersinbiz.mailbox", originId: "thread:acc-1:th-1" });
    expect(host.wakeups).toEqual([issues[0]!.id]);
  });
});
