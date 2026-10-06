import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_VERSION } from "../src/namespace.js";
import { ESIGN_PERSON_ACTIONS, ESIGN_TOOL_NAMES } from "../src/esign-dispatch.js";
import { ESIGN_TOOLS } from "../src/esign-tools.js";
import { GROWTH_TOOL_NAMES } from "../src/growth-dispatch.js";
import { GROWTH_TOOLS } from "../src/growth-tools.js";
import { CRM_TOOLS } from "../src/tools.js";
import { BOARD, bootCare, CO, tool } from "./helpers/care.js";

const NEW_TOOLS = [...ESIGN_TOOLS, ...GROWTH_TOOLS];

describe("what 0.14.0 declares", () => {
  it("is the next version, in the package and the manifest", async () => {
    expect(PLUGIN_VERSION).toBe("0.15.0");
    expect(manifest.version).toBe("0.15.0");
    const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.15.0");
  });

  it("adds no capability and no core table: the host already lets this plugin do all of it", () => {
    // These are the capabilities and read tables of 0.13.0; a new one would force an approval, so a change here is deliberate.
    expect(manifest.capabilities).toEqual([
      "companies.read", "access.members.read", "agents.read", "authorization.grants.read", "authorization.grants.write", "database.namespace.migrate", "database.namespace.read",
      "database.namespace.write", "agent.tools.register", "skills.managed", "jobs.schedule", "events.subscribe", "events.emit", "plugin.state.read", "plugin.state.write", "secrets.read-ref",
      "projects.read", "http.outbound", "issues.read", "issues.create", "issues.update", "issues.wakeup", "issue.comments.create", "issue.documents.write", "api.routes.register",
      "webhooks.receive", "ui.page.register", "ui.sidebar.register",
    ]);
    expect(manifest.database?.coreReadTables).toEqual(["heartbeat_runs", "issues", "cost_events"]);
  });

  it("declares three public endpoints, each its own key, and the same jobs as before (the new work rides in the care job)", () => {
    expect((manifest.webhooks ?? []).map((hook) => hook.endpointKey)).toEqual(["lead", "sign", "ev"]);
    expect((manifest.jobs ?? []).map((job) => job.jobKey)).toEqual(["open-due-steps", "redeliver-mail", "held-leads", "emit-recent", "emit-all", "setup-status", "sales-daily", "services-check", "site-monitor", "client-care", "client-health", "client-report-monthly", "sales-weekly"]);
  });

  it("declares every new tool once, with every parameter described and no extra parameters accepted", () => {
    const all = CRM_TOOLS.map((t) => t.name);
    expect(new Set(all).size).toBe(all.length);
    expect(NEW_TOOLS.map((t) => t.name).sort()).toEqual([...ESIGN_TOOL_NAMES, ...GROWTH_TOOL_NAMES].sort());
    for (const declared of NEW_TOOLS) {
      expect(all, declared.name).toContain(declared.name);
      expect(declared.description.length, declared.name).toBeGreaterThan(80);
      const schema = declared.parametersSchema as { properties: Record<string, { description?: string }>; additionalProperties: boolean; required: string[] };
      expect(schema.additionalProperties, declared.name).toBe(false);
      for (const [name, property] of Object.entries(schema.properties)) expect(property.description, `${declared.name}.${name}`).toBeTruthy();
      for (const name of schema.required) expect(Object.keys(schema.properties), `${declared.name} requires ${name}`).toContain(name);
    }
  });

  it("no tool can hand an agent a signing link, a write secret or a person's address: nothing in the schemas asks for or returns one", () => {
    for (const declared of ESIGN_TOOLS) {
      const text = JSON.stringify(declared.parametersSchema);
      expect(text, declared.name).not.toMatch(/"(token|link|url|secret|password)"/i);
    }
    expect(ESIGN_TOOLS.map((t) => t.name)).not.toContain("enable-esign");
    expect(ESIGN_PERSON_ACTIONS).toEqual(["enable-esign", "disable-esign"]);
  });

  it("each new tool is also a page action the board can run, and the two doors give the same answer", async () => {
    const { harness } = await bootCare();
    const viaPage = await harness.performAction<Record<string, any>>("crm.sign-templates", {}, { companyId: CO, actor: BOARD });
    const viaTool = await tool<Record<string, any>>(harness, "sign-templates", {});
    expect(viaPage).toEqual(viaTool);
    const keys = await harness.performAction<Record<string, any>>("crm.list-event-keys", {}, { companyId: CO, actor: BOARD });
    expect(keys.keys).toEqual([]);
    const report = await harness.performAction<Record<string, any>>("crm.attribution-report", { days: 7 }, { companyId: CO, actor: BOARD });
    expect(report.scope).toBe("own");
  });

  it("the tool descriptions carry the rules: nothing is installed, the link is never shown, counts are estimates", () => {
    const text = (name: string) => NEW_TOOLS.find((t) => t.name === name)!.description;
    expect(text("create-event-key")).toMatch(/only RETURNS the snippet/);
    expect(text("create-event-key")).toMatch(/never by you on the live site/);
    // True to what runs: no tool or issue shows the link, but the email that carries it does, so an agent must not read or sign from it.
    expect(text("send-for-signature")).toMatch(/No tool or issue shows it and you must not ask for it/);
    expect(text("send-for-signature")).toMatch(/never read, open, forward or sign from a signing email/);
    expect(text("send-for-signature")).not.toMatch(/NEVER shown|goes only to the client's inbox/);
    expect(text("create-sign-document")).toMatch(/Only works for the canary client until the owner has turned e-sign on/);
    expect(text("site-events-report")).toMatch(/Counts are estimates/);
    expect(text("attribution-report")).toMatch(/never present a number the report does not show/);
    expect(text("record-lead-outcome")).toMatch(/Only record what the client said/);
    expect(text("record-channel-cost")).toMatch(/never estimate one/);
  });

  it("the lawyer's checklist exists and names the template version and every template, so it cannot drift from the code", async () => {
    const { readFileSync } = await import("node:fs");
    const { TEMPLATE_KEYS, TEMPLATE_VERSION } = await import("../src/esign-templates.js");
    const doc = readFileSync(new URL("../docs/esign-legal-review.md", import.meta.url), "utf8");
    expect(doc).toContain(`**${TEMPLATE_VERSION}**`);
    expect(doc).toMatch(/not legal advice/i);
    expect(doc).toMatch(/not an advanced electronic signature/i);
    for (const key of TEMPLATE_KEYS) expect(doc.toLowerCase(), key).toContain(key.replace("-", " ").split(" ")[0]!);
    // The Setup line points at it by its path.
    const { esignSetupItem } = await import("../src/esign.js");
    const booted = await bootCare();
    expect((await esignSetupItem(booted.harness.ctx, CO)).steps!.join("\n")).toContain("docs/esign-legal-review.md");
    // The owner is told, before turning it on for a real client, that the sent email holds the link and who must not read it.
    expect((await esignSetupItem(booted.harness.ctx, CO)).steps!.join("\n")).toMatch(/no agent should be able to read the mailbox the signing emails are sent from/);
  });
});
