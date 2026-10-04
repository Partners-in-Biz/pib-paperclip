import { describe, expect, it } from "vitest";
import { BOARD, CO, bootCare, canaryClient, enableFor, makeDoc, sendAndApprove, tool, usePages } from "./helpers/esign.js";

usePages();

const workspace = (booted: Awaited<ReturnType<typeof bootCare>>, client = "company:acme") =>
  booted.harness.performAction<Record<string, any>>("crm.client-workspace", { client }, { companyId: CO, actor: BOARD });

describe("the client page reads agreements and growth in one call", () => {
  it("says e-sign is off for a real client and lists nothing", async () => {
    const booted = await bootCare();
    const ws = await workspace(booted);
    expect(ws.agreements).toMatchObject({ allowed: false, canary: false, documents: [] });
    expect(ws.growth).toMatchObject({ days: 90, channels: [], siteKeys: [], site: null });
  });

  it("shows the documents after a person turned e-sign on, and never a signing link or a token", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await sendAndApprove(booted, made.documentId);
    const ws = await workspace(booted);
    expect(ws.agreements.allowed).toBe(true);
    expect(ws.agreements.documents).toHaveLength(1);
    expect(ws.agreements.documents[0]).toMatchObject({ documentId: made.documentId, status: "sent" });
    const text = JSON.stringify(ws.agreements);
    expect(text).not.toContain(sent.token);
    expect(text).not.toContain(sent.pageId);
    expect(text).not.toMatch(/pibt_/);
    expect(text).not.toMatch(/ui\/s\//);
  });

  it("lists the client's site counters without the write key or the snippet", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-event-key", { client: "company:acme", siteUrl: "https://acme.co.za" });
    const writeKey: string = made.key.writeKey;
    expect(writeKey).toMatch(/^pibe_/);
    const ws = await workspace(booted);
    expect(ws.growth.siteKeys).toHaveLength(1);
    expect(ws.growth.siteKeys[0]).toMatchObject({ label: "Acme Plumbing website", status: "active", consentMode: "anonymous", counted: 0 });
    expect(ws.growth.site).toMatchObject({ visits: 0, pageviews: 0, conversions: 0 });
    const text = JSON.stringify(ws.growth);
    expect(text).not.toContain(writeKey);
    expect(text).not.toMatch(/<script/);
  });

  it("an agent cannot turn e-sign on from the page action, and the page shows it still off", async () => {
    const booted = await bootCare();
    const agent = { type: "agent", agentId: "am-1" } as never;
    await expect(booted.harness.performAction("crm.enable-esign", { client: "company:acme", confirm: true }, { companyId: CO, actor: agent })).rejects.toThrow(/Only a person/);
    expect((await workspace(booted)).agreements.allowed).toBe(false);
  });

  it("the canary client is always on", async () => {
    const booted = await bootCare();
    const client = await canaryClient(booted);
    expect((await workspace(booted, client)).agreements).toMatchObject({ allowed: true, canary: true });
  });
});
