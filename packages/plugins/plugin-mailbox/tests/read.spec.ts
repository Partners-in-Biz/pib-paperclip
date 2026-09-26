import { describe, expect, it } from "vitest";
import { bodyText, correctTriage, readMessageBody, searchMail } from "../src/gmail/read.js";
import { syncAccount } from "../src/gmail/sync.js";
import { jevAnswers } from "./helpers/fake-gmail.js";
import { JEV_CONFIG, setup } from "./helpers/setup.js";

describe("correct-triage", () => {
  it("logs the correction on the Jev decision and swaps the Gmail labels", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup(JEV_CONFIG);
    gmail.jevResponse = jevAnswers({
      category: { type: "choice", choice: "spam", probabilities: {}, confidence: 0.8 },
      urgency: { type: "score", score: 0.2, probabilities: {}, confidence: 0.8 },
      needs_reply: { type: "noul", noul: 0.1 },
      phishing: { type: "noul", noul: 0.05 },
    });
    gmail.addMessage({ id: "s1", headers: { From: "ceo@bigclient.com", Subject: "Partnership?" } });
    await syncAccount(env, await loaded(), account, await run());
    const row = store.messages.get("gm_acc-1_s1")!;
    expect(row.triage!.labels).toEqual(["PiB/Spam"]);
    const spamId = store.accounts.get("acc-1")!.label_ids!["PiB/Spam"]!;
    expect(gmail.messages.get("s1")!.labelIds).toContain(spamId);

    const out = await correctTriage(env, await loaded(), { ...row }, { category: "lead", needsReply: true, urgency: 2 }, "user-1");
    expect(out.decisionsCorrected).toBe(3);
    expect(out.relabelled).toBe(true);
    expect(host.decisions.find((d) => d.question_key === "category")).toMatchObject({ corrected_to: "lead", corrected_by: "user-1" });
    expect(host.decisions.find((d) => d.question_key === "needs_reply")).toMatchObject({ corrected_to: "1" });
    expect(host.decisions.find((d) => d.question_key === "phishing")!.corrected_to).toBeNull();
    const fixed = store.messages.get("gm_acc-1_s1")!;
    expect(fixed).toMatchObject({ category: "lead", needs_reply: 1, urgency: 2 });
    expect(fixed.triage).toMatchObject({ source: "correction", labels: ["PiB/Lead", "PiB/Needs reply"] });
    const labels = gmail.messages.get("s1")!.labelIds;
    expect(labels).not.toContain(spamId);
    expect(labels).toContain(store.accounts.get("acc-1")!.label_ids!["PiB/Lead"]);

    await expect(correctTriage(env, await loaded(), fixed, { category: "nonsense" }, null)).rejects.toThrow(/category must be one of/);
    await expect(correctTriage(env, await loaded(), fixed, { client: "acme" }, null)).rejects.toThrow(/company:<id>/);
  });
});

describe("reading on demand", () => {
  it("returns the text part, or converted html, truncated", async () => {
    const { gmail, env, account, loaded } = setup();
    gmail.addMessage({
      id: "b1",
      headers: { From: "Ann <ann@x.co>", To: "peet@partnersinbiz.online", Subject: "Long one", Date: "Fri, 25 Sep 2026 10:00:00 +0200" },
      payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", data: `Hello Peet,\r\n${"a".repeat(500)}` }, { mimeType: "text/html", data: "<p>Hello</p>" }] },
    });
    const body = await readMessageBody(env, await loaded(), account, "b1", 200);
    expect(body).toMatchObject({ subject: "Long one", from: { email: "ann@x.co", name: "Ann" }, truncated: true });
    expect(body.text).toHaveLength(200);
    expect(body.text.startsWith("Hello Peet,\n")).toBe(true);
    expect(bodyText({ mimeType: "text/html", body: { data: Buffer.from("<p>Hi <b>you</b></p>").toString("base64url") } })).toBe("Hi you");
  });

  it("searches with a Gmail query and returns headers and snippets only", async () => {
    const { gmail, env, account, loaded } = setup();
    gmail.addMessage({ id: "q1", headers: { From: "a@acme.com", To: "peet@partnersinbiz.online", Subject: "Order 1" }, snippet: "first" });
    const result = await searchMail(env, await loaded(), account, "from:acme.com newer_than:30d", 50);
    const list = gmail.calls.find((c) => c.url.pathname.endsWith("/messages") && c.method === "GET")!;
    expect(list.url.searchParams.get("q")).toBe("from:acme.com newer_than:30d");
    expect(list.url.searchParams.get("maxResults")).toBe("25");
    expect(result.messages[0]).toMatchObject({ gmailMessageId: "q1", subject: "Order 1", snippet: "first", from: { email: "a@acme.com" } });
    expect(gmail.calls.filter((c) => /\/messages\/q1$/.test(c.url.pathname)).every((c) => c.url.searchParams.get("format") === "metadata")).toBe(true);
  });
});
