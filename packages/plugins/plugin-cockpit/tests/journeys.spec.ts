/**
 * The journey files against the plugins they call (Q5-1). A journey names real
 * tools with real parameters; when a plugin renames a tool or a parameter the
 * journey would fail at night and nobody would know whether the product or the
 * file was wrong. This test makes the file the first thing to fail: it loads every
 * plugin's manifest and checks each tool step against it, the way the kit's
 * contract specs do for skills.
 */
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
  it("are the five the audit asked for, plus the nightly lead capture, each with its own key", () => {
    expect(JOURNEYS.map((j) => j.key)).toEqual(["lead-capture", "quote-to-invoice", "email-sequence-dry-run", "social-draft-review", "seo-sprint-draft", "client-report"]);
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
    for (const j of JOURNEYS.filter((x) => x.plugins.some((p) => p !== "partnersinbiz.crm") || x.key === "email-sequence-dry-run")) {
      const opens = toolSteps(j).filter(({ name }) => /^(request-invoice-send|request-quote-send|set-sequence-delivery|send-client-report)$/.test(name) || (name === "create-sequence" && JSON.stringify(j.steps) .includes('"delivery":"email"')));
      for (const { step } of opens) expect(step.probe?.kind, `${j.key}: ${step.id}`).toBe("approval-route");
    }
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
    const vars = { client: "company:canary-1a2b3c4d", companyRecordId: "canary-1a2b3c4d", runId: "r1", date: "2026-10-04", futureDate: "2027-11-08", period: "2026-09", contactId: "canary-contact-1a2b", dealId: "d1", quoteId: "q1", invoiceId: "i1", sequenceId: "s1", postId: "p1", sprintId: "sp1", leadCurl: "curl -d '{\"email\":\"canary@canary.invalid\"}'", acceptedBefore: 0 };
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

describe("what a trigger runs", () => {
  it("the nightly set is the lead capture alone: it makes no quote, invoice, approval or post", () => {
    expect(journeysFor("nightly").map((j) => j.key)).toEqual(["lead-capture"]);
  });

  it("a release of a plugin runs the journeys that exercise it, and a release of an unrelated one runs none", () => {
    expect(journeysFor("release", "partnersinbiz.billing").map((j) => j.key)).toEqual(["quote-to-invoice"]);
    expect(journeysFor("release", "partnersinbiz.social").map((j) => j.key)).toEqual(["social-draft-review"]);
    expect(journeysFor("release", "partnersinbiz.seo").map((j) => j.key)).toEqual(["seo-sprint-draft"]);
    expect(journeysFor("release", "partnersinbiz.crm").map((j) => j.key).sort()).toEqual(["client-report", "email-sequence-dry-run", "lead-capture", "quote-to-invoice"]);
    expect(journeysFor("release", "partnersinbiz.payroll")).toEqual([]);
  });

  it("on demand runs every journey", () => {
    expect(journeysFor("on-demand")).toHaveLength(JOURNEYS.length);
  });
});
