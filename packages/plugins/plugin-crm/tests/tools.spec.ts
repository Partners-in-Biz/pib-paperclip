import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { ASKING_HEADING } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { CRM_OUTBOUND_SKILL, CRM_RECORDS_SKILL, SKILLS } from "../src/skills.js";
import { CRM_TOOLS } from "../src/tools.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

type Schema = JsonSchema & { properties?: Record<string, Schema>; items?: Schema; description?: string; enum?: unknown[]; type?: string };

/** Every parameter, nested ones included, as [path, schema]. */
function params(schema: Schema, prefix = ""): Array<[string, Schema]> {
  const out: Array<[string, Schema]> = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push([path, value]);
    if (value.type === "array" && value.items?.properties) out.push(...params(value.items, `${path}[]`));
    if (value.type === "object" && value.properties) out.push(...params(value, path));
  }
  return out;
}

const FIXED: Record<string, string[]> = {
  lifecycle: ["lead", "prospect", "customer", "churned"],
  recordType: ["contact", "company", "deal"],
  nextActionKind: ["call", "email", "meet"],
  principalType: ["user", "agent"],
  completionMode: ["manual", "sent"],
  delivery: ["issue", "email"],
  action: ["add", "remove"],
  kind: [],
  fieldType: ["text", "number", "date", "boolean", "url"],
  status: [],
};

describe("the CRM tool surface", () => {
  it("every parameter of every tool has a description", () => {
    const missing = CRM_TOOLS.flatMap((tool) => params(tool.parametersSchema as Schema).filter(([, schema]) => !schema.description?.trim()).map(([path]) => `${tool.name}.${path}`));
    expect(missing).toEqual([]);
  });

  it("parameters with fixed values carry an enum", () => {
    const loose = CRM_TOOLS.flatMap((tool) =>
      params(tool.parametersSchema as Schema)
        .filter(([path]) => path in FIXED)
        .filter(([, schema]) => !Array.isArray(schema.enum) || schema.enum.length === 0)
        .map(([path]) => `${tool.name}.${path}`),
    );
    expect(loose).toEqual([]);
    const lifecycle = CRM_TOOLS.find((t) => t.name === "update-company")!.parametersSchema as Schema;
    expect(lifecycle.properties!.lifecycle!.enum).toEqual(FIXED.lifecycle);
  });

  it("create-company and update-company take the five billing details, each described", () => {
    for (const name of ["create-company", "update-company"]) {
      const props = (CRM_TOOLS.find((t) => t.name === name)!.parametersSchema as Schema).properties!;
      for (const key of ["billingEmail", "phone", "address", "vatNumber", "registrationNumber"]) {
        expect(props[key], `${name}.${key}`).toMatchObject({ type: "string" });
        expect(props[key]!.description!.length).toBeGreaterThan(10);
      }
      expect(props.address!.description).toMatch(/multi-line postal address as printed on invoices/i);
    }
  });

  it("has the read and search tools, and no complete-step", () => {
    const names = CRM_TOOLS.map((tool) => tool.name);
    for (const name of ["find-records", "get-company", "get-contact", "list-deals", "list-stages", "list-sequences", "get-client-profile", "update-client-profile", "set-email-status"]) expect(names).toContain(name);
    expect(names).not.toContain("complete-step");
    expect(new Set(names).size).toBe(names.length);
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(names);
  });

  it("find-records caps its limit at 25; set-email-status never lets an agent allow email", () => {
    const find = CRM_TOOLS.find((t) => t.name === "find-records")!.parametersSchema as Schema;
    expect(find.properties!.limit).toMatchObject({ minimum: 1, maximum: 25 });
    const status = CRM_TOOLS.find((t) => t.name === "set-email-status")!.parametersSchema as Schema;
    expect(status.properties!.status!.enum).toEqual(["unsubscribed", "bounced"]);
  });
});

describe("crm 006 migration", () => {
  const sql = readFileSync(new URL("../migrations/006_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments", () => {
    for (const statement of splitSqlStatements(sql)) {
      expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    }
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    for (const table of ["client_profiles", "client_leads", "held_leads", "handoffs"]) expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    expect(sql).toContain("ADD COLUMN won_at timestamptz");
    expect(sql).not.toMatch(/\bdelete\b/i);
  });
});

describe("the CRM skills", () => {
  const records = SKILLS.find((s) => s.skillKey === "crm-records")!.markdown!;
  const outbound = SKILLS.find((s) => s.skillKey === "crm-outbound")!.markdown!;

  it("carry the memory and asking sections from the kit", () => {
    for (const markdown of [records, outbound]) {
      expect(markdown).toMatch(/^---\nname: pib-crm-/);
      expect(markdown).toContain("## Company memory");
      expect(markdown).toContain(ASKING_HEADING);
    }
  });

  it("name every merge token, the fallback form and the marketing email rules", () => {
    for (const token of ["{{first_name}}", "{{last_name}}", "{{name}}", "{{company}}", "{{email}}", "{{first_name|there}}"]) expect(CRM_OUTBOUND_SKILL).toContain(token);
    for (const rule of ["POPIA", "Who we are", "Opt-out", "set-email-status"]) expect(CRM_OUTBOUND_SKILL).toContain(rule);
    expect(CRM_OUTBOUND_SKILL).toContain("the Social agent replies in the Social inbox");
  });

  it("walk the client lifecycle and say how to find a client first", () => {
    for (const step of ["find-records", "Lead.", "Qualified.", "Proposal.", "Won.", "Onboarding", "Monthly client report", "Offboarding.", "company:<id>"]) expect(CRM_RECORDS_SKILL).toContain(step);
    expect(CRM_RECORDS_SKILL).toContain("wait 15 minutes");
  });

  it("drop what no longer holds: complete-step, asking for a resync, asking people in comments", () => {
    for (const text of [CRM_RECORDS_SKILL, CRM_OUTBOUND_SKILL]) {
      expect(text).not.toContain("complete-step");
      expect(text).not.toMatch(/ask (a person|someone) to (run )?(a )?resync/i);
      expect(text).not.toMatch(/@-?mention/i);
    }
  });
});
