/**
 * The journey files against the plugins they call (Q5-1). A journey names real
 * tools with real parameters; when a plugin renames a tool or a parameter the
 * journey would fail at night and nobody would know whether the product or the
 * file was wrong. This test makes the file the first thing to fail: it loads every
 * plugin's manifest and checks each tool step against it, the way the kit's
 * contract specs do for skills.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardInput, renderValue, type Journey } from "../src/acceptance-model.js";
import { JOURNEYS, journeyByKey, journeysFor } from "../src/journeys.js";

type Tool = { name: string; parametersSchema?: { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } };
const PLUGINS = ["crm", "billing", "social", "seo", "campaigns", "mailbox"] as const;

const tools = new Map<string, Map<string, Tool>>();
for (const plugin of PLUGINS) {
  const manifest = (await import(`../../plugin-${plugin}/src/manifest.ts`)).default as { id: string; tools?: Tool[] };
  tools.set(manifest.id, new Map((manifest.tools ?? []).map((t) => [t.name, t])));
}

const toolSteps = (j: Journey) => j.steps.filter((s) => s.kind === "tool").map((s) => ({ step: s, plugin: s.tool!.split(":")[0]!, name: s.tool!.split(":")[1]! }));

describe("the shipped journeys", () => {
  it("are the five the audit asked for, the nightly lead capture, and (0.6.0) e-sign and the site visit counter, each with its own key", () => {
    expect(JOURNEYS.map((j) => j.key)).toEqual(["lead-capture", "quote-to-invoice", "email-sequence-dry-run", "social-draft-review", "seo-sprint-draft", "client-report", "esign", "site-events"]);
    expect(new Set(JOURNEYS.map((j) => j.key)).size).toBe(JOURNEYS.length);
    expect(journeyByKey("lead-capture")!.title).toBe("Lead captured and qualified");
    expect(journeyByKey("ghost")).toBeNull();
  });

  it("run only on the canary: each starts by asking for it and ends by cleaning it up", () => {
    for (const j of JOURNEYS) {
      expect(j.steps[0]!.tool, j.key).toBe("partnersinbiz.crm:create-canary-client");
      const last = j.steps[j.steps.length - 1]!;
      expect(last.tool, j.key).toBe("partnersinbiz.crm:cleanup-canary");
      expect(last.always, j.key).toBe(true);
      expect(last.input, j.key).toEqual({ confirm: true });
    }
  });

  it("only the nightly ones are safe to run every night: no send, approval, payment or launch", () => {
    const outward = /^(request-|send-|launch-|record-payment|create-payment-link|set-sequence-delivery|enroll-contact|schedule-post|connect-)/;
    for (const j of JOURNEYS.filter((x) => x.schedule.includes("nightly"))) {
      for (const { name, step } of toolSteps(j)) expect(outward.test(name), `${j.key}: ${name}`).toBe(false);
      expect(j.steps.some((s) => s.probe?.kind === "approval-route"), j.key).toBe(false);
    }
  });

  it("every journey that opens an approval checks where it went", () => {
    for (const j of JOURNEYS) {
      const opens = toolSteps(j).filter(({ name }) => /^(request-invoice-send|request-quote-send|set-sequence-delivery|send-client-report|send-for-signature)$/.test(name) || (name === "create-sequence" && JSON.stringify(j.steps) .includes('"delivery":"email"')));
      for (const { step } of opens) expect(step.probe?.kind, `${j.key}: ${step.id}`).toBe("approval-route");
    }
    // The e-sign journey is one of them: sending a document for signature is an approval, and it must reach the Reviewer first.
    expect(journeyByKey("esign")!.steps.filter((s) => s.tool === "partnersinbiz.crm:send-for-signature")).toEqual([expect.objectContaining({ probe: { kind: "approval-route", idPath: "approvalIssueId", outward: true } })]);
  });

  it("each has a real expectation, not only 'something came back'", () => {
    for (const j of JOURNEYS) {
      const real = j.steps.some((s) => s.expect.some((e) => e.path !== "$" && ("equals" in e || "endsWith" in e || "matches" in e || "oneOf" in e || "gtCapture" in e || "gte" in e)));
      expect(real, j.key).toBe(true);
    }
  });

  it("list the plugins they exercise, each of which has a step", () => {
    for (const j of JOURNEYS) for (const plugin of j.plugins) expect(toolSteps(j).some((t) => t.plugin === plugin) || j.steps.some((s) => s.kind === "http"), `${j.key} lists ${plugin} but never calls it`).toBe(true);
  });

  it("never carry a real address or another client in what they send", () => {
    const vars = { client: "company:canary-1a2b3c4d", companyRecordId: "canary-1a2b3c4d", runId: "r1", date: "2026-10-04", futureDate: "2027-11-08", period: "2026-09", contactId: "canary-contact-1a2b", dealId: "d1", quoteId: "q1", invoiceId: "i1", sequenceId: "s1", postId: "p1", sprintId: "sp1", leadCurl: "curl -d '{\"email\":\"canary@canary.invalid\"}'", acceptedBefore: 0, documentId: "doc-1", contentSha256: "a".repeat(64), keyId: "key-1", eventCurl: "curl -X POST 'https://paperclip.example/ev' -d '{\"k\":\"pibe_test\"}'", entrancesBefore: 0, pageviewsBefore: 0 };
    for (const j of JOURNEYS) for (const s of j.steps) expect(guardInput(renderValue(s.input ?? {}, vars), "company:canary-1a2b3c4d"), `${j.key}: ${s.id}`).toEqual([]);
  });
});

describe("the journeys against the plugins' manifests", () => {
  it("each tool step names a tool its plugin ships, unless it is planned (then the plugin must not ship it yet)", () => {
    for (const j of JOURNEYS) {
      for (const { step, plugin, name } of toolSteps(j)) {
        const shipped = tools.get(plugin);
        expect(shipped, `${j.key}: ${plugin} is not a plugin this test loads`).toBeDefined();
        const exists = shipped!.has(name);
        if (step.planned) expect(exists, `${j.key}: ${step.tool} now exists: remove "planned": true from step ${step.id}`).toBe(false);
        else expect(exists, `${j.key}: ${step.tool} is not a tool (renamed or removed?)`).toBe(true);
      }
    }
  });

  it("each call uses only parameters the tool has, and gives every one it requires", () => {
    for (const j of JOURNEYS) {
      for (const { step, plugin, name } of toolSteps(j)) {
        if (step.planned) continue;
        const schema = tools.get(plugin)!.get(name)!.parametersSchema ?? {};
        const properties = Object.keys(schema.properties ?? {});
        const given = Object.keys(step.input ?? {});
        for (const key of given) expect(properties, `${j.key}: ${step.tool} has no parameter ${key}`).toContain(key);
        for (const key of schema.required ?? []) expect(given, `${j.key}: ${step.tool} needs ${key}`).toContain(key);
      }
    }
  });

  it("each step's enumerated input values are values the tool accepts", () => {
    for (const j of JOURNEYS) {
      for (const { step, plugin, name } of toolSteps(j)) {
        if (step.planned) continue;
        const properties = (tools.get(plugin)!.get(name)!.parametersSchema?.properties ?? {}) as Record<string, { enum?: unknown[] }>;
        for (const [key, value] of Object.entries(step.input ?? {})) if (properties[key]?.enum) expect(properties[key]!.enum, `${j.key}: ${step.tool} ${key}`).toContain(value);
      }
    }
  });
});

describe("the e-sign journey (0.6.0)", () => {
  const esign = journeyByKey("esign")!;
  const calls = (name: string) => esign.steps.filter((s) => s.tool === `partnersinbiz.crm:${name}`);

  it("runs on a release of the CRM and on demand, never at night: it opens an approval", () => {
    expect(esign.schedule).toEqual(["release", "on-demand"]);
    expect(esign.plugins).toEqual(["partnersinbiz.crm"]);
    expect(journeysFor("nightly").map((j) => j.key)).not.toContain("esign");
  });

  it("uses the real e-sign tools in this order, on the document it made, and ends by withdrawing it and cleaning the canary up", () => {
    expect(esign.steps.map((s) => s.tool?.split(":")[1])).toEqual(["create-canary-client", "create-sign-document", "get-sign-document", "send-for-signature", "verify-sign-document", "list-sign-documents", "void-sign-document", "get-sign-document", "cleanup-canary"]);
    for (const name of ["get-sign-document", "send-for-signature", "verify-sign-document", "void-sign-document"]) for (const step of calls(name)) expect(step.input?.documentId, `${name}: ${step.id}`).toBe("{{documentId}}");
    // What it reads back is the document it made: the same SHA-256, an intact trail.
    expect(calls("get-sign-document")[0]!.expect).toContainEqual({ path: "contentSha256", equals: "{{contentSha256}}" });
    expect(calls("verify-sign-document")[0]!.expect).toContainEqual({ path: "ok", equals: true });
  });

  it("makes the document for the canary only, from the template, with one of the canary's own people and nothing real", () => {
    const [create] = calls("create-sign-document");
    expect(create!.input).toMatchObject({ client: "{{client}}", template: "proposal", contactId: "{{contactId}}" });
    expect(Object.keys(create!.input!)).not.toContain("toEmail");
    expect(create!.expect).toContainEqual({ path: "canary", equals: true });
    expect(create!.expect).toContainEqual({ path: "to", contains: "@canary.invalid" });
  });

  it("never asks for, captures or uses a signing link: every look at the link says it must be absent", () => {
    const text = JSON.stringify(esign.steps);
    expect(text).not.toMatch(/pibt_/);
    for (const step of esign.steps) {
      for (const e of step.expect.filter((x) => x.path === "canaryLink")) expect(e, `${step.id}`).toEqual({ path: "canaryLink", exists: false });
      expect(Object.keys(step.capture ?? {}), step.id).not.toContain("canaryLink");
    }
    expect(esign.steps.some((s) => s.kind === "ui"), "nothing here opens a signing page").toBe(false);
  });

  it("opens exactly one approval, sends nothing and leaves nothing waiting", () => {
    expect(esign.steps.filter((s) => s.probe?.kind === "approval-route")).toHaveLength(1);
    const sends = esign.steps.filter((s) => /^partnersinbiz\.[a-z]+:(request-|send-|record-payment|create-payment-link)/.test(s.tool ?? ""));
    expect(sends.map((s) => s.tool)).toEqual(["partnersinbiz.crm:send-for-signature"]);
    // The approval is withdrawn by the journey itself, as well as cancelled by the Cockpit when the run ends.
    expect(calls("void-sign-document")[0]!.expect).toContainEqual({ path: "emailsWithdrawn", gte: 1 });
  });

  it("says plainly what it does not script: the signature and the invoice it makes need a person", () => {
    expect(esign.summary).toContain("the Acceptance agent never approves");
    expect(esign.summary).toContain("refuses a signature made from this server");
    expect(esign.summary).toContain("Billing's own tests");
  });
});

describe("the e-sign and site events journeys read fields the CRM's tools really return (0.6.0)", () => {
  // The manifests only name tools and parameters. A renamed result field would fail a night rather than the build, so every field name the two journeys
  // read, capture or clean up after is looked for in the CRM source that builds the answer.
  const crm = ["esign.ts", "esign-tools.ts", "site-events.ts", "growth-tools.ts", "canary.ts"].map((name) => readFileSync(new URL(`../../plugin-crm/src/${name}`, import.meta.url), "utf8")).join("\n");
  const words = (path: string): string[] => path.replace(/\[[^\]]*\]/g, " ").split(/[.\s]+/).filter((w) => /^[A-Za-z][A-Za-z0-9]*$/.test(w));

  it("every path an expectation, a capture, a probe or a cleanup names is a word the CRM's answer code uses", () => {
    for (const key of ["esign", "site-events"]) {
      for (const step of journeyByKey(key)!.steps.filter((x) => x.kind === "tool")) {
        const paths = [...step.expect.map((e) => e.path), ...Object.values(step.capture ?? {}).map((c) => c.path), ...(step.probe ? [step.probe.idPath] : []), ...(step.cleanupIssues ?? [])];
        for (const path of paths) for (const word of words(path)) expect(crm, `${key}/${step.id}: ${path} (${word})`).toMatch(new RegExp(`\\b${word}\\b`));
      }
    }
  });

  it("the work issue a document opens for the deal desk is named by the send step, so the run can cancel it", () => {
    const [send] = journeyByKey("esign")!.steps.filter((x) => x.tool === "partnersinbiz.crm:send-for-signature");
    expect(send!.cleanupIssues).toEqual(["workIssueId"]);
    expect(crm).toContain("workIssueId: issueId");
  });
});

describe("the site events journey (0.6.0)", () => {
  const events = journeyByKey("site-events")!;
  const step = (id: string) => events.steps.find((s) => s.id === id)!;

  it("runs on a release of the CRM and on demand: it posts to a public endpoint, so the nightly run stays with the lead form", () => {
    expect(events.schedule).toEqual(["release", "on-demand"]);
    expect(events.plugins).toEqual(["partnersinbiz.crm"]);
    expect(journeysFor("nightly").map((j) => j.key)).toEqual(["lead-capture"]);
  });

  it("makes the key for the canary only and gives it no site: nothing can be pointed at a real site or installed", () => {
    const make = step("make-key");
    expect(make.tool).toBe("partnersinbiz.crm:create-event-key");
    expect(Object.keys(make.input!).sort()).toEqual(["client", "label"]);
    expect(make.input).toMatchObject({ client: "{{client}}" });
    expect(make.expect).toContainEqual({ path: "key.canary", equals: true });
  });

  it("posts the test event with the curl the tool itself gave, and keeps the evidence", () => {
    const post = step("send-test-event");
    expect(post.kind).toBe("http");
    expect(post.input).toEqual({ curl: "{{eventCurl}}" });
    expect(post.evidence).toEqual(["curl"]);
    expect(step("make-key").capture).toMatchObject({ eventCurl: { path: "key.install.curl" } });
  });

  it("checks the daily counter moved against a reading taken before the post, not against zero", () => {
    expect(step("count-before").capture).toMatchObject({ entrancesBefore: { path: "entrances" }, pageviewsBefore: { path: "pageviews" } });
    expect(step("confirm-counter-moved").expect).toEqual([{ path: "entrances", gtCapture: "entrancesBefore" }, { path: "pageviews", gtCapture: "pageviewsBefore" }]);
    // The post comes between the two readings.
    const order = events.steps.map((s) => s.id);
    expect(order.indexOf("count-before")).toBeLessThan(order.indexOf("send-test-event"));
    expect(order.indexOf("send-test-event")).toBeLessThan(order.indexOf("confirm-counter-moved"));
  });

  it("looks at the key it made and nothing else, pauses it (an agent may; only a person revokes) and cleans up", () => {
    expect(step("key-counted").expect.every((e) => e.path.startsWith("keys[id={{keyId}}]"))).toBe(true);
    expect(step("pause-key").input).toEqual({ keyId: "{{keyId}}", status: "paused" });
    expect(events.steps.at(-1)!.tool).toBe("partnersinbiz.crm:cleanup-canary");
  });
});

describe("what a trigger runs", () => {
  it("the nightly set is the lead capture alone: it makes no quote, invoice, approval or post", () => {
    expect(journeysFor("nightly").map((j) => j.key)).toEqual(["lead-capture"]);
  });

  it("a release of a plugin runs the journeys that exercise it, and a release of an unrelated one runs none", () => {
    expect(journeysFor("release", "partnersinbiz.billing").map((j) => j.key)).toEqual(["quote-to-invoice"]);
    expect(journeysFor("release", "partnersinbiz.social").map((j) => j.key)).toEqual(["social-draft-review"]);
    expect(journeysFor("release", "partnersinbiz.seo").map((j) => j.key)).toEqual(["seo-sprint-draft"]);
    expect(journeysFor("release", "partnersinbiz.crm").map((j) => j.key).sort()).toEqual(["client-report", "email-sequence-dry-run", "esign", "lead-capture", "quote-to-invoice", "site-events"]);
    expect(journeysFor("release", "partnersinbiz.payroll")).toEqual([]);
  });

  it("on demand runs every journey", () => {
    expect(journeysFor("on-demand")).toHaveLength(JOURNEYS.length);
  });
});
