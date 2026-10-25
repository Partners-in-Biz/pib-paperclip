import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { TOKEN_DEFAULTS, companySetupIssueText, findBrandLeaks, hireTaskDraft, isOwnerCompany, renderTokens, withFrontmatter } from "../src/index.js";

const ctxFor = (company: unknown) => ({ companies: { get: async () => company } }) as unknown as PluginContext;

describe("renderTokens", () => {
  it("renders the three tokens to neutral defaults", () => {
    expect(renderTokens("{{company}} / {{owner}} / {{ownerTitle}}")).toBe("this company / the company owner / owner");
    expect(renderTokens("Ask {{ owner }}.")).toBe("Ask the company owner.");
    expect(TOKEN_DEFAULTS.ownerTitle).toBe("owner");
  });

  it("uses a value the caller knows, and the default for a blank one", () => {
    expect(renderTokens("Welcome to {{company}}.", { company: "Acme" })).toBe("Welcome to Acme.");
    expect(renderTokens("{{company}}", { company: "  " })).toBe("this company");
  });

  it("fails on an unknown token and names it", () => {
    expect(() => renderTokens("Hello {{compnay}}")).toThrow("{{compnay}}");
    expect(() => renderTokens("{{include:evidence}}")).toThrow("{{include:evidence}}");
    expect(() => renderTokens("{{toString}} {{constructor}}")).toThrow("Unknown token");
  });

  it("passes the documented merge fields through untouched", () => {
    expect(renderTokens("Hi {{first_name}}, <{{email}}> {{unsubscribe_url}} {{ name }}")).toBe("Hi {{first_name}}, <{{email}}> {{unsubscribe_url}} {{ name }}");
    expect(() => renderTokens("{{first_name}} {{frist_name}}")).toThrow("{{frist_name}}");
  });

  it("leaves text without tokens, and single braces, alone", () => {
    expect(renderTokens("plain `{ a: 1 }` text")).toBe("plain `{ a: 1 }` text");
  });
});

describe("withFrontmatter renders tokens", () => {
  it("no {{ reaches a rendered skill", () => {
    const md = withFrontmatter({ name: "pib-x", description: "For {{owner}}" }, "Ask {{owner}} ({{ownerTitle}}).");
    expect(md).not.toContain("{{");
    expect(md).toContain("Ask the company owner (owner).");
    expect(md).toContain('description: "For the company owner"');
  });

  it("keeps {{company}} in skill text (the CRM and Campaigns email merge field)", () => {
    const md = withFrontmatter({ name: "pib-x", description: "d" }, "Merge tokens: `{{first_name}}`, `{{company}}`. Ask {{owner}}.");
    expect(md).toContain("`{{first_name}}`, `{{company}}`");
    expect(md).toContain("Ask the company owner.");
  });

  it("throws on an unknown token in the body", () => {
    expect(() => withFrontmatter({ name: "pib-x", description: "d" }, "Ask {{boss}}.")).toThrow("{{boss}}");
  });
});

describe("the other renderers use the same tokens", () => {
  it("a company name that looks like a token does not break the setup issue", () => {
    const text = companySetupIssueText({ name: "Acme {{x}}", prefix: null });
    expect(text.title).toBe("Set up Acme {{x}}");
    expect(text.description).toContain("Acme {{x}} is new.");
  });

  it("the setup issue text renders with the company name", () => {
    const text = companySetupIssueText({ name: "Acme", prefix: "ACM" });
    expect(text.title).toBe("Set up Acme");
    expect(text.description).not.toContain("{{");
  });

  it("a hire task draft carries no raw token", () => {
    const role = {
      pluginKey: "partnersinbiz.x",
      pluginName: "X",
      roleKey: "x-agent",
      role: "general",
      displayName: "X Agent",
      title: "X Agent",
      capabilities: "Does x for {{company}}.",
      instructions: "Report to {{owner}}.",
      skills: [],
      pluginSetup: [],
      budgetMonthlyCents: 1000,
      adapterPreference: ["claude_local"],
    } as unknown as Parameters<typeof hireTaskDraft>[0];
    const draft = hireTaskDraft(role);
    expect(draft.description).not.toContain("{{");
    expect(draft.description).toContain("Report to the company owner.");
    expect(() => hireTaskDraft({ ...role, instructions: "Report to {{boss}}." })).toThrow("{{boss}}");
  });
});

describe("isOwnerCompany", () => {
  it("is true for the PAR company", async () => {
    expect(await isOwnerCompany(ctxFor({ issuePrefix: "PAR" }), "c1")).toBe(true);
  });

  it("is false for any other company", async () => {
    expect(await isOwnerCompany(ctxFor({ issuePrefix: "ACM" }), "c2")).toBe(false);
    expect(await isOwnerCompany(ctxFor({ issuePrefix: "par" }), "c2")).toBe(false);
    expect(await isOwnerCompany(ctxFor({}), "c2")).toBe(false);
  });

  it("is false when the company is missing or the lookup fails", async () => {
    expect(await isOwnerCompany(ctxFor(null), "c3")).toBe(false);
    const failing = { companies: { get: async () => { throw new Error("boom"); } } } as unknown as PluginContext;
    expect(await isOwnerCompany(failing, "c3")).toBe(false);
  });
});

describe("findBrandLeaks", () => {
  it("finds the owner's names, the agency name and PiB, with line numbers", () => {
    const leaks = findBrandLeaks("ok line\nAsk Peet to approve.\nElon holds the key.\nWelcome to Partners in Biz!\nthe PiB plugins\nPIB rules");
    expect(leaks.map((l) => [l.term, l.line])).toEqual([["Peet", 2], ["Elon", 3], ["Partners in Biz", 4], ["PiB", 5], ["PiB", 6]]);
    expect(leaks[0]!.excerpt).toBe("Ask Peet to approve.");
  });

  it("matches the agency name in any case, and whole words only", () => {
    expect(findBrandLeaks("PARTNERS IN BIZ").map((l) => l.term)).toEqual(["Partners in Biz"]);
    expect(findBrandLeaks("Peeter, Elonora, Pibble, a pib-company-os skill, partnersinbiz.crm, `pib-plugin-kit`")).toEqual([]);
  });

  it("is clean for neutral text", () => {
    expect(findBrandLeaks("Ask the company owner. Call `company-profile` for this company's names.")).toEqual([]);
  });

  it("ignores allowlisted product names but still reports the rest of the line", () => {
    expect(findBrandLeaks("Open PiB Cockpit.", { allow: ["PiB Cockpit"] })).toEqual([]);
    expect(findBrandLeaks("Open PiB Cockpit, ask Peet.", { allow: ["PiB Cockpit"] }).map((l) => l.term)).toEqual(["Peet"]);
    expect(findBrandLeaks("Open PiB Cockpit.")).toHaveLength(1);
  });

  it("reports every term on a line", () => {
    expect(findBrandLeaks("Peet at Partners in Biz").map((l) => l.term)).toEqual(["Peet", "Partners in Biz"]);
  });
});
