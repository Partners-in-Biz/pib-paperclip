import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASKING_HEADING, COMPANY_MEMORY_HEADING } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE, PLUGIN_VERSION } from "../src/namespace.js";
import { CAMPAIGN_SKILL, SKILLS } from "../src/skills.js";
import { CAMPAIGN_TOOLS } from "../src/tools.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

type SafeParse = { safeParse(value: unknown): { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

/** The host's own manifest schema (read-only, loaded at runtime so tsc keeps its rootDir). */
async function hostManifestSchema(): Promise<SafeParse> {
  const url = new URL("../../../shared/src/validators/plugin.ts", import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ url)) as { pluginManifestV1Schema: SafeParse };
  return mod.pluginManifestV1Schema;
}

describe("manifest 0.6", () => {
  it("passes the host manifest validator", async () => {
    const result = (await hostManifestSchema()).safeParse(manifest);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });

  it("is version 0.6.0 everywhere", () => {
    expect(manifest.version).toBe("0.6.0");
    expect(PLUGIN_VERSION).toBe("0.6.0");
    expect(pkg.version).toBe("0.6.0");
  });

  it("declares a public unsubscribe endpoint and an optional reply endpoint, and the capabilities that need", () => {
    expect(manifest.webhooks).toEqual([
      expect.objectContaining({ endpointKey: "unsubscribe" }),
      expect.objectContaining({ endpointKey: "messaging-inbound" }),
    ]);
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["webhooks.receive", "http.outbound", "projects.read", "projects.managed"]));
    expect(manifest.jobs?.map((job) => [job.jobKey, job.schedule])).toEqual([
      ["open-due-steps", "*/5 * * * *"],
      ["redeliver-mail", "*/5 * * * *"],
      ["poll-messaging", "*/10 * * * *"],
      ["setup-status", "19 * * * *"],
    ]);
    expect(manifest.projects).toEqual([expect.objectContaining({ projectKey: "campaigns", displayName: "Campaigns" })]);
    // No new core tables are read: client project routing and approvals need none.
    expect(manifest.database?.coreReadTables).toEqual(["heartbeat_runs", "issues"]);
  });

  it("keeps secrets as typed-less secret-refs and the SMS and WhatsApp block off until it is filled", () => {
    const schema = manifest.instanceConfigSchema as Record<string, any>;
    const messaging = schema.properties.messaging;
    expect(messaging.properties.authToken).toMatchObject({ format: "secret-ref" });
    expect(messaging.properties.authToken.type).toBeUndefined();
    expect(messaging.properties.inboundWebhookSecret).toMatchObject({ format: "secret-ref" });
    expect(messaging.properties.inboundWebhookSecret.type).toBeUndefined();
    // Nothing in the schema switches a provider on by default.
    for (const key of ["accountSid", "smsFrom", "whatsappFrom", "messagingServiceSid"]) expect(messaging.properties[key].default).toBeUndefined();
    expect(schema.required).toBeUndefined();
    expect(schema.properties.publicBaseUrl).toBeTruthy();
    expect(schema.properties.oneClickUnsubscribeUrl).toBeTruthy();
    expect(messaging.properties.sunday.default).toBe("off");
  });

  it("registers a tool for every skill promise and describes every parameter", () => {
    const names = CAMPAIGN_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ["set-sender-identity", "remove-sender-identity", "list-sender-identities", "record-channel-consent", "suppress-phone", "preflight-campaign"]) expect(names).toContain(name);
    for (const tool of CAMPAIGN_TOOLS) {
      const props = ((tool.parametersSchema as { properties?: Record<string, { description?: string }> }).properties) ?? {};
      for (const [key, value] of Object.entries(props)) expect(value.description, `${tool.name}.${key}`).toBeTruthy();
    }
    for (const tool of CAMPAIGN_TOOLS) expect(CAMPAIGN_SKILL, tool.name).toContain(`\`${tool.name}\``);
  });
});

describe("the skill", () => {
  const skill = SKILLS[0]!;

  it("stays within the 18,000 character budget with the memory and asking sections, and its references ship with it", () => {
    expect(skill.markdown!.length).toBeLessThanOrEqual(18_000);
    expect(skill.markdown).toContain(COMPANY_MEMORY_HEADING);
    expect(skill.markdown).toContain(ASKING_HEADING);
    expect(skill.files?.map((file) => file.path)).toEqual(["references/channels.md", "references/senders-and-unsubscribe.md", "references/privacy.md"]);
    for (const file of skill.files ?? []) expect(file.content.length, file.path).toBeGreaterThan(500);
    // The skill points at them.
    for (const path of ["references/channels.md", "references/senders-and-unsubscribe.md", "references/privacy.md"]) expect(CAMPAIGN_SKILL).toContain(path);
  });

  it("names only tools that exist (in the skill and in its references)", () => {
    const names = new Set(CAMPAIGN_TOOLS.map((tool) => tool.name));
    const external = new Set(["partnersinbiz.crm:find-records", "partnersinbiz.crm:get-client-profile", "partnersinbiz.crm:set-email-status", "partnersinbiz.mailbox:create-draft", "partnersinbiz.mailbox:send-draft", "partnersinbiz.mailbox:get-message"]);
    const docs = [CAMPAIGN_SKILL, ...(skill.files ?? []).map((file) => file.content)];
    for (const text of docs) {
      for (const match of text.matchAll(/partnersinbiz\.campaigns:([a-z-]+)/g)) expect(names.has(match[1]!), match[0]).toBe(true);
      for (const match of text.matchAll(/partnersinbiz\.(crm|mailbox):([a-z-]+)/g)) expect(external.has(match[0]), match[0]).toBe(true);
    }
  });

  it("teaches the rules that keep clients and recipients safe", () => {
    for (const rule of [/never goes out from PiB's Gmail or number/, /opt-in only/i, /Never record an opt-in you did not see/i, /per sender/i, /Reply STOP to opt out/, /never repeated|never send.* again/i]) {
      expect([CAMPAIGN_SKILL, ...(skill.files ?? []).map((file) => file.content)].join("\n")).toMatch(rule);
    }
    expect(CAMPAIGN_SKILL).toMatch(/Never mark an approval issue done/);
    expect(CAMPAIGN_SKILL).toMatch(/text anyone without a recorded opt-in/);
  });
});

describe("migration 013", () => {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
  const sql = readFileSync(new URL("../migrations/013_campaigns.sql", import.meta.url), "utf8");

  it("is the next migration and passes the host migration guard, with no quotes in comments and nothing destructive", () => {
    expect(files.at(-1)).toBe("013_campaigns.sql");
    expect(files).toHaveLength(13);
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
  });

  it("never edits an applied migration", () => {
    // 001 to 012 are applied on the live host; their checksums must not move. Their first lines are stable markers.
    const first = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").split("\n")[0];
    expect(first("011_campaigns.sql")).toBe("-- Campaigns 0.4.0: one suppression list fed by Campaigns, the CRM and the Mailbox, and launch on approval.");
    expect(first("012_campaigns.sql")).toBe("-- Campaigns 0.5.0: when a draft last changed (a refused campaign must change before it is asked");
  });
});
