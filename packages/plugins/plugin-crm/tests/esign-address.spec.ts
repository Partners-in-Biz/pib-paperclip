/**
 * A signing link is only ever made on the installation uuid address. Checked on the live host: the plugin key address
 * (`/_plugins/partnersinbiz.crm/ui/...`) answers every request, even for a missing file, with HTTP 500, so a link built on it is dead.
 * The plugin therefore refuses to make one until the CRM page has reported the uuid, exactly as the lead form and the event snippet do.
 *
 * The kit remembers the uuid in a module-level cache that cannot be cleared, so each test starts from a fresh module graph and the
 * uuid is only told to the one test that wants it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const UUID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const dirs: string[] = [];

async function fresh() {
  vi.resetModules();
  const care = await import("./helpers/care.js");
  const es = await import("./helpers/esign.js");
  const pagesModule = await import("../src/esign-pages.js");
  const kit = await import("@partnersinbiz/pib-plugin-kit");
  const resets = await import("../src/lead-capture.js");
  resets.resetLeadCaches();
  const dir = mkdtempSync(join(tmpdir(), "crm-address-"));
  dirs.push(dir);
  pagesModule.configurePagesDir(dir);
  return { care, es, kit, dir, link: await import("../src/esign-link.js"), store: await import("../src/esign-store.js"), outbound: await import("../src/outbound.js") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a signing link needs the plugin's own address", () => {
  it("with the uuid unknown, no address is made and no token is stored", async () => {
    const { care, link, kit } = await fresh();
    const booted = await care.bootCare();
    expect(await link.signUrls(booted.harness.ctx, care.CO)).toBeNull();
    const doc = { companyId: care.CO, id: "doc-1", pageId: "abcdefghijklmnopqrstuvwx", status: "draft", expiresAt: null, brand: {}, content: "x", contentSha256: "x", consentText: "x", consentSha256: "x", title: "T", recipientName: "R", signedAt: null, declinedAt: null, signerName: null, auditHead: null } as never;
    // The address is checked before anything is stored.
    await expect(link.mintLink(booted.harness.ctx, doc, { approvalId: "a1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).rejects.toBeInstanceOf(link.SigningAddressUnknown);
    expect(booted.store.sign_tokens ?? []).toEqual([]);
    // Once the CRM page reports the uuid, the address is the uuid one and never the key one.
    await kit.rememberPluginUiBase(booted.harness.ctx, `/_plugins/${UUID}/ui/`);
    expect((await link.signUrls(booted.harness.ctx, care.CO))!.pageBase).toBe(`https://paperclip.partnersinbiz.online/_plugins/${UUID}/ui/s/`);
  });

  it("send-for-signature refuses before any approval is opened, and says what to do", async () => {
    const { care, es } = await fresh();
    const booted = await care.bootCare();
    await es.enableFor(booted);
    const made = await es.makeDoc(booted, "company:acme");
    await expect(es.tool(booted.harness, "send-for-signature", { documentId: made.documentId })).rejects.toThrow(/Open the CRM page once .* the signing link needs it/);
    expect((booted.store.care_approvals ?? []).filter((a) => a.kind === "esign_request")).toEqual([]);
    expect(booted.store.sign_documents![0]).toMatchObject({ status: "draft" });
    expect(booted.store.sign_tokens ?? []).toEqual([]);
  });

  it("an approval that is already open fails cleanly when the address was lost: nothing minted, nothing sent, the document a draft again", async () => {
    const { care, es, store, outbound, dir } = await fresh();
    const booted = await care.bootCare();
    await es.enableFor(booted);
    const made = await es.makeDoc(booted, "company:acme");
    // An approval opened while the address was still known (the state was lost between the ask and the person's decision).
    const doc = (await store.getDoc(booted.harness.ctx, care.CO, made.documentId))!;
    await store.moveDoc(booted.harness.ctx, care.CO, doc.id, ["draft"], { status: "awaiting_approval", expiresAt: null });
    const opened = await outbound.requestApproval(booted.harness.ctx, {
      companyId: care.CO,
      kind: "esign_request",
      client: { kind: "company", id: "acme" },
      subjectId: doc.id,
      title: "Approve signing link for Acme Plumbing",
      intro: ["x"],
      draft: { to: [{ email: "ada@acme.co.za", name: "Ada" }], subject: "Please sign", text: "Open it here: {{signing_link}}\nWorks until {{valid_until}}." },
      checks: [],
      outward: true,
    });
    booted.emit.mockClear();
    await care.decide(booted.harness, opened.issueId!, "done", "user");
    expect(care.sentMail(booted.emit)).toHaveLength(0);
    expect(booted.store.outbox ?? []).toEqual([]);
    expect(booted.store.sign_tokens ?? []).toEqual([]);
    const approval = booted.store.care_approvals!.find((a) => a.kind === "esign_request")!;
    expect(approval.status).toBe("failed");
    expect(approval.error).toMatch(/Open the CRM page once/);
    expect(booted.store.sign_documents![0]).toMatchObject({ status: "draft", expires_at: null });
    // No page was written for a link that does not exist.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((name) => name.endsWith(".html"))).toEqual([]);
  });

  it("the canary's link is left out, with the same note, when the address is unknown (it never falls back to the key address)", async () => {
    const { care, es } = await fresh();
    const booted = await care.bootCare();
    const client = await es.canaryClient(booted);
    const made = await es.makeDoc(booted, client);
    // The state a canary document is in after its journey, with the address since lost.
    Object.assign(booted.store.sign_documents!.find((row) => row.id === made.documentId)!, { status: "sent", canary_token: `pibt_${"a".repeat(40)}` });
    const got = await es.tool<Record<string, any>>(booted.harness, "get-sign-document", { documentId: made.documentId });
    expect(got).not.toHaveProperty("canaryLink");
    expect(got.canaryNote).toMatch(/Open the CRM page once/);
    expect(JSON.stringify(got)).not.toContain("partnersinbiz.crm/ui");
  });
});
