/**
 * What an agent is given: every tool parameter explained, a skill that walks
 * the whole monthly cycle and asks people only through ask-owner, and the
 * hire role ending with the company operating manual.
 */
import { describe, expect, it } from "vitest";
import { ASK_OWNER_TOOL, COMPANY_OS_HIRE_SKILL } from "@partnersinbiz/pib-plugin-kit";
import { instanceConfigSchema, payrollConfigFrom } from "../src/config.js";
import { CLERK_ROLE } from "../src/hire.js";
import manifest from "../src/manifest.js";
import { SKILLS } from "../src/skills.js";
import { PAYROLL_TOOLS } from "../src/tools.js";

type Prop = { description?: string; enum?: unknown[]; default?: unknown; items?: Prop & { properties?: Record<string, Prop> }; properties?: Record<string, Prop> };

describe("payroll tools", () => {
  it("every parameter has a description, and fixed values an enum", () => {
    const walk = (tool: string, props: Record<string, Prop>, path: string) => {
      for (const [name, prop] of Object.entries(props)) {
        expect(prop.description, `${tool}.${path}${name}`).toMatch(/\S/);
        if (prop.properties) walk(tool, prop.properties, `${path}${name}.`);
        if (prop.items?.properties) walk(tool, prop.items.properties, `${path}${name}[].`);
      }
    };
    for (const tool of PAYROLL_TOOLS) walk(tool.name, (tool.parametersSchema as { properties?: Record<string, Prop> }).properties ?? {}, "");
    const props = (name: string) => (PAYROLL_TOOLS.find((t) => t.name === name)!.parametersSchema as { properties: Record<string, Prop> }).properties;
    expect(props("create-pay-run").frequency!.enum).toEqual(["monthly", "fortnightly", "weekly"]);
    expect(props("request-leave").type!.enum).toEqual(["annual", "sick", "family", "unpaid"]);
    expect(props("emp501-summary").period!.enum).toEqual(["interim", "annual"]);
    expect(manifest.tools?.map((t) => t.name)).toEqual(PAYROLL_TOOLS.map((t) => t.name));
  });
});

describe("the pib-payroll skill", () => {
  const md = SKILLS[0]!.markdown!;

  it("walks the whole cycle: prepare, calculate, approval, lock, payslips, EMP201, EMP501", () => {
    for (const step of ["### 1. Prepare", "### 2. Calculate and check", "### 3. Approval", "### 4. Lock and the books", "### 5. Payslips", "### 6. EMP201", "### 7. EMP501", "## Who does what"]) expect(md, step).toContain(step);
    for (const tool of PAYROLL_TOOLS) expect(md, tool.name).toContain(`\`${tool.name}\``);
    expect(md).toContain("Leave `approverUserId` out to use the default approver");
  });

  it("asks people through ask-owner, never in a comment", () => {
    expect(md).toContain(ASK_OWNER_TOOL);
    expect(md).not.toMatch(/say so on the issue|leave a comment|ask a person to add them/i);
    expect(CLERK_ROLE.instructions).toContain(ASK_OWNER_TOOL);
    expect(CLERK_ROLE.instructions).not.toMatch(/say so on the issue/i);
  });

  it("the hire role ends with the company operating manual", () => {
    expect(CLERK_ROLE.skills.at(-1)).toEqual(COMPANY_OS_HIRE_SKILL);
    expect(CLERK_ROLE.pluginSetup.join(" ")).toContain("Prepare pay run");
  });
});

describe("settings", () => {
  it("lock on approval is on by default, the pay run starts 5 days before pay day, and sendOnLock is explained", () => {
    const props = (instanceConfigSchema as { properties: Record<string, Prop> }).properties;
    expect(props.approval!.properties!.lockOnApproval).toMatchObject({ type: "boolean", default: true });
    expect(props.prepareDaysBefore).toMatchObject({ type: "integer", default: 5, minimum: 1, maximum: 20 });
    expect(props.payslipEmail!.properties!.sendOnLock!.description).toMatch(/Mailbox/);
    const ctx = { logger: { info: () => undefined } } as never;
    expect(payrollConfigFrom(ctx, "c", {})).toMatchObject({ lockOnApproval: true, prepareDaysBefore: 5 });
    expect(payrollConfigFrom(ctx, "c", { approval: { lockOnApproval: false }, prepareDaysBefore: 8 })).toMatchObject({ lockOnApproval: false, prepareDaysBefore: 8 });
  });
});
