import { createHash } from "node:crypto";
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

  it("is version 0.7.0 everywhere", () => {
    expect(manifest.version).toBe("0.7.0");
    expect(PLUGIN_VERSION).toBe("0.7.0");
    expect(pkg.version).toBe("0.7.0");
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

describe("migrations", () => {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
  const read = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

  it("013 passes the host migration guard, with no quotes in comments and nothing destructive", () => {
    const sql = read("013_campaigns.sql");
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
  });

  it("014 is the next migration, passes the host guard, widens the step event kinds and indexes the sent events by address", () => {
    const sql = read("014_campaigns.sql");
    expect(files.at(-1)).toBe("014_campaigns.sql");
    expect(files).toHaveLength(14);
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    // Every kind of 013 stays allowed, and the two new ones are added.
    expect(sql).toContain("CHECK (event_type IN ('open', 'click', 'sent', 'reply', 'bounce', 'unsubscribe', 'skipped', 'delivered', 'failed', 'soft_bounce', 'complaint'))");
    expect(sql).toContain("WHERE event_type = 'sent'");
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bupdate\b/i);
  });

  it("never edits an applied migration: 001 to 013 are live and each file still has the hash it was applied with", () => {
    const applied: Record<string, string> = {
      "001_campaigns.sql": "cb49831db73842f7713fa9955fc8b25cea439f75e4e35d3ebff8ea24ff8d960e",
      "002_campaigns.sql": "2553260da7795e4ca89dc5d0f9a11f124acdb74ad21728d9fa9ae129f3074c77",
      "003_campaigns.sql": "6b9246efa6359f87150ccef6f9eef2bbb83f129fc20ec3c33a60e2611e8bb114",
      "004_campaigns.sql": "19664c4e9d37df3e998e26e03786d0b00b96fc61c6b541e351fe2026f43b318a",
      "005_campaigns.sql": "105265c9bd999393bc934f002b96035b8c6269a02a49e93521348cee056fea3c",
      "006_campaigns.sql": "b3948b08537df90311cb8484e545dcb174d53355bd798b548dd646ca78bd1352",
      "007_campaigns.sql": "8d52f8048ed0713d272a19fb14c5c5d5123a2f1b58b9e0fb0269b30514478d16",
      "008_campaigns.sql": "406763292c6569b4e4b2b269b3d914c2048d67a78376419cddbc542a222d4ffe",
      "009_campaigns.sql": "c4bb5c5bd256506da9be18c4581928db36f5d3fbefd3c5d8c263a4070b0081cd",
      "010_campaigns.sql": "78aef4c10cff70d4fd23ca66dc1e7844f59b0032376f701ea6609936f5017473",
      "011_campaigns.sql": "a2cf86b0f61c4c09ddaa874df52c6540a78158a481224ea911b9ae451024ad87",
      "012_campaigns.sql": "4b79dab38b9ab0dc7dbdcff92e399df5a0a7b3e4c7a916592a5d7e7a37720106",
      "013_campaigns.sql": "26c2095386695151fa743255ed7938cb16135e70cf87da4e6cb7029d29648fbd",
    };
    for (const [name, hash] of Object.entries(applied)) expect(createHash("sha256").update(readFileSync(new URL(`../migrations/${name}`, import.meta.url))).digest("hex"), `${name} was edited after it was applied: add 015 instead`).toBe(hash);
  });
});
