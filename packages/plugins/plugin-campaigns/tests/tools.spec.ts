import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { CAMPAIGN_SKILL, SKILLS } from "../src/skills.js";
import { CAMPAIGN_TOOLS } from "../src/tools.js";

type Schema = { type?: string; description?: string; enum?: unknown[]; properties?: Record<string, Schema>; items?: Schema };

/** Every property (and nested item property) with its path. */
function params(schema: Schema, path = ""): Array<[string, Schema]> {
  const out: Array<[string, Schema]> = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    out.push([`${path}${key}`, value]);
    if (value.items?.properties) out.push(...params(value.items, `${path}${key}[].`));
  }
  return out;
}

describe("Campaigns tool surface", () => {
  it("describes every parameter", () => {
    const missing: string[] = [];
    for (const tool of CAMPAIGN_TOOLS) {
      for (const [name, schema] of params(tool.parametersSchema as Schema)) if (!schema.description?.trim()) missing.push(`${tool.name}.${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("uses enums where the values are fixed", () => {
    const enumOf = (tool: string, param: string) => ((CAMPAIGN_TOOLS.find((t) => t.name === tool)!.parametersSchema as Schema).properties![param]!).enum;
    expect(enumOf("create-campaign", "audienceMode")).toEqual(["tags", "client_contacts", "client_contact"]);
    expect(enumOf("create-campaign", "delivery")).toEqual(["issue", "email"]);
    expect(enumOf("create-campaign", "clientKind")).toEqual(["company", "contact"]);
    expect(enumOf("record-step-event", "eventType")).toEqual(["open", "click"]);
    expect(enumOf("declare-ab-winner", "winner")).toEqual(["a", "b"]);
    expect(enumOf("set-step-html", "variant")).toEqual(["a", "b"]);
    expect(enumOf("suppress-address", "reason")).toEqual(["unsubscribe", "complaint", "manual"]);
  });

  it("drops complete-step (marking the step issue done moves the contact on) and adds the stop and opt-out tools", () => {
    const names = CAMPAIGN_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain("complete-step");
    expect(names).toEqual(expect.arrayContaining(["stop-enrollment", "suppress-address", "request-campaign-approval", "launch-campaign"]));
    expect(manifest.tools).toBe(CAMPAIGN_TOOLS);
  });

  it("declares what launch on approval and the shared list need", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["issues.update", "issue.comments.create", "agents.read", "events.emit", "events.subscribe"]));
    expect(manifest.database?.coreReadTables).toContain("issues");
  });
});

describe("Campaigns skill", () => {
  it("teaches POPIA, opt-out and sender identity", () => {
    expect(CAMPAIGN_SKILL).toMatch(/POPIA/);
    expect(CAMPAIGN_SKILL).toMatch(/say who we are/);
    expect(CAMPAIGN_SKILL).toMatch(/why they get it/);
    expect(CAMPAIGN_SKILL).toMatch(/Reply STOP/);
    expect(CAMPAIGN_SKILL).toMatch(/unsubscribe header/);
  });

  it("lists every merge token and the fallback form", () => {
    for (const token of ["{{first_name}}", "{{last_name}}", "{{name}}", "{{company}}", "{{email}}", "{{first_name|there}}"]) expect(CAMPAIGN_SKILL).toContain(token);
  });

  it("matches how the module works now", () => {
    expect(CAMPAIGN_SKILL).not.toMatch(/complete-step/);
    expect(CAMPAIGN_SKILL).not.toMatch(/resync/i);
    expect(CAMPAIGN_SKILL).toMatch(/within 15 minutes/);
    expect(CAMPAIGN_SKILL).toMatch(/launches by itself/);
    expect(CAMPAIGN_SKILL).toMatch(/All contacts \(N\)/);
    for (const tool of CAMPAIGN_TOOLS) expect(CAMPAIGN_SKILL, tool.name).toContain(`\`${tool.name}\``);
  });

  it("ships with the company memory and asking sections", () => {
    const markdown = SKILLS[0]!.markdown!;
    expect(markdown).toMatch(/^---\nname: pib-campaigns\n/);
    expect(markdown).toContain("## Company memory");
    expect(markdown).toContain("## Asking a person");
  });
});
