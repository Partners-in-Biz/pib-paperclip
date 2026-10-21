import { describe, expect, it } from "vitest";
import { applySignedEffects } from "../src/esign.js";
import { getDoc, patchDoc } from "../src/esign-store.js";
import { issuesWith, CO, decide, tool } from "./helpers/care.js";
import { usePages, makeDoc, sendAndApprove, enableFor, signBody, bootCare, canaryClient, BROWSER, SERVER_IPS } from "./helpers/esign.js";
import { handleSignWebhook } from "../src/esign-public.js";

const pages = usePages();

/** One row from the signed documents store. */
const docRow = (booted: Awaited<ReturnType<typeof bootCare>>, id?: string) => booted.store.sign_documents!.find((row) => !id || row.id === id)!;

describe("filing signed copies to Drive", () => {
  it("opens exactly one filing issue when a document is signed twice", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await sendAndApprove(booted, made.documentId);
    const docStoreRow = docRow(booted, made.documentId);

    // Sign the document.
    const signBody_ = signBody({ pageId: sent.pageId, contentSha256: docStoreRow.content_sha256, consentSha256: docStoreRow.consent_sha256 }, sent.token);
    await handleSignWebhook(booted.harness.ctx, {
      endpointKey: "sign",
      headers: { "x-real-ip": "203.0.113.50", "user-agent": BROWSER },
      rawBody: JSON.stringify(signBody_),
      parsedBody: signBody_,
      requestId: "req-1",
    }, { serverIps: SERVER_IPS });

    // Apply signed effects, which runs through all steps including the filing step.
    let doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    await applySignedEffects(booted.harness.ctx, doc);

    // Check that a filing issue was opened.
    const filingIssues1 = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues1).toHaveLength(1);

    // Run the signed effects again (as the care job would do if the first run was incomplete).
    doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    // Mark it as not yet done so the care job will run again.
    await patchDoc(booted.harness.ctx, CO, doc.id, { effectsDoneAt: null });
    await applySignedEffects(booted.harness.ctx, doc);

    // The filing issue should still be exactly one (deduped by origin).
    const filingIssues2 = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues2).toHaveLength(1);
    expect(filingIssues2[0].id).toBe(filingIssues1[0].id);
  });

  it("writes the signed copy document to the filing issue", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await sendAndApprove(booted, made.documentId);
    const docStoreRow = docRow(booted, made.documentId);

    // Sign the document.
    const signBody_ = signBody({ pageId: sent.pageId, contentSha256: docStoreRow.content_sha256, consentSha256: docStoreRow.consent_sha256 }, sent.token);
    await handleSignWebhook(booted.harness.ctx, {
      endpointKey: "sign",
      headers: { "x-real-ip": "203.0.113.50", "user-agent": BROWSER },
      rawBody: JSON.stringify(signBody_),
      parsedBody: signBody_,
      requestId: "req-1",
    }, { serverIps: SERVER_IPS });

    // Apply signed effects.
    let doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    await applySignedEffects(booted.harness.ctx, doc);

    // Get the signed copy markdown from the document.
    doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    const signedCopyMd = doc.signedCopyMd;
    expect(signedCopyMd).toBeTruthy();

    // Get the filing issue and read its document.
    const filingIssues = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues).toHaveLength(1);
    const filingIssueId = filingIssues[0].id;

    // Read the issue document with key "signed-copy-to-file".
    const body = booted.documents.bodyOf(filingIssueId, "signed-copy-to-file");
    expect(body).toBe(signedCopyMd);
  });

  it("title and description contain no URLs or local filesystem paths", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await sendAndApprove(booted, made.documentId);
    const docRow_ = docRow(booted, made.documentId);

    // Sign the document.
    const signBody_ = signBody({ pageId: sent.pageId, contentSha256: docRow_.content_sha256, consentSha256: docRow_.consent_sha256 }, sent.token);
    await handleSignWebhook(booted.harness.ctx, {
      endpointKey: "sign",
      headers: { "x-real-ip": "203.0.113.50", "user-agent": BROWSER },
      rawBody: JSON.stringify(signBody_),
      parsedBody: signBody_,
      requestId: "req-1",
    }, { serverIps: SERVER_IPS });

    // Apply signed effects.
    let doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    await applySignedEffects(booted.harness.ctx, doc);

    // Get the filing issue.
    const filingIssues = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues).toHaveLength(1);
    const issue = filingIssues[0];

    // Check title and description for URLs and paths.
    expect(issue.title).not.toMatch(/http/i);
    expect(issue.title).not.toMatch(/\/home|\/tmp/);
    expect(issue.description).not.toMatch(/http/i);
    expect(issue.description).not.toMatch(/\/home|\/tmp/);

    // Check the document body as well.
    doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    expect(doc.signedCopyMd).not.toMatch(/http/i);
    expect(doc.signedCopyMd).not.toMatch(/\/home|\/tmp/);
  });

  it("description mentions Contracts & Quotes folder and pib-drive-saving skill", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await sendAndApprove(booted, made.documentId);
    const docRow_ = docRow(booted, made.documentId);

    // Sign the document.
    const signBody_ = signBody({ pageId: sent.pageId, contentSha256: docRow_.content_sha256, consentSha256: docRow_.consent_sha256 }, sent.token);
    await handleSignWebhook(booted.harness.ctx, {
      endpointKey: "sign",
      headers: { "x-real-ip": "203.0.113.50", "user-agent": BROWSER },
      rawBody: JSON.stringify(signBody_),
      parsedBody: signBody_,
      requestId: "req-1",
    }, { serverIps: SERVER_IPS });

    // Apply signed effects.
    let doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    await applySignedEffects(booted.harness.ctx, doc);

    // Get the filing issue.
    const filingIssues = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues).toHaveLength(1);
    const issue = filingIssues[0];

    // Check that the description mentions the required folder and skill.
    expect(issue.description).toContain("Contracts & Quotes/");
    expect(issue.description).toContain("pib-drive-saving");
  });

  it("canary client does not create a filing issue", async () => {
    const booted = await bootCare();
    const client = await canaryClient(booted);
    const made = await makeDoc(booted, client);
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    booted.emit.mockClear();
    await decide(booted.harness, sent.approvalIssueId, "done", "user");

    // For canary client, the email is not queued (it's a dry run), but we can get the canary token from the doc.
    let doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    expect(doc.canaryToken).toBeTruthy();
    const docRow_ = docRow(booted, made.documentId);

    // Sign it with the canary token.
    const signBody_ = signBody({ pageId: docRow_.page_id, contentSha256: docRow_.content_sha256, consentSha256: docRow_.consent_sha256 }, doc.canaryToken!);
    await handleSignWebhook(booted.harness.ctx, {
      endpointKey: "sign",
      headers: { "x-real-ip": "203.0.113.50", "user-agent": BROWSER },
      rawBody: JSON.stringify(signBody_),
      parsedBody: signBody_,
      requestId: "req-1",
    }, { serverIps: SERVER_IPS });

    // Apply signed effects.
    doc = (await getDoc(booted.harness.ctx, CO, made.documentId))!;
    await applySignedEffects(booted.harness.ctx, doc);

    // The canary client should have no filing issue.
    const filingIssues = await issuesWith(booted.harness, "crm:drive-file:esign:");
    expect(filingIssues).toHaveLength(0);
  });
});
