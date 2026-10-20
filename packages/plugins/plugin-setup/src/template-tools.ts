/**
 * Setup agent tools: template-list, template-get.
 * Pure declarations and handlers (no I/O except company lookup in get).
 */
import type { JsonSchema, PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { loadPack, packSources, templateByKey, templateVars, type AgentTemplate, type TemplateVars } from "./templates.js";
import { renderInstructions } from "./templates-render.js";
import { renderHash } from "./render-hash.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

interface CompanyInfo {
  name: string;
  prefix: string | null;
}

/** Read company name and issue prefix for template rendering. */
async function getCompanyInfo(ctx: PluginContext, companyId: string): Promise<CompanyInfo> {
  try {
    const company = (await ctx.companies.get(companyId)) as { name?: string; issuePrefix?: string | null } | null;
    return { name: company?.name ?? "the company", prefix: company?.issuePrefix ?? null };
  } catch {
    return { name: "the company", prefix: null };
  }
}

export const TEMPLATE_TOOLS: PluginToolDeclaration[] = [
  {
    name: "template-list",
    displayName: "List templates",
    description:
      "The team template pack: every agent template with its key, file name, scope, host-owned flag, and render hash. Host-owned templates have no hash. Read-only.",
    parametersSchema: schema([], {}),
  },
  {
    name: "template-get",
    displayName: "Get template",
    description:
      "A single template's full details: raw source text, rendered output, render hash, subagents policy and extra arguments. For a company-specific company (if companyId given), rendering uses that company's template variables (name, prefix, CEO). Host-owned templates return a stub with no raw/rendered/hash.",
    parametersSchema: schema(["key"], {
      key: { type: "string", description: "The template key from template-list" },
      companyId: { type: "string", description: "Optional: render with this company's variables" },
    }),
  },
];

/** List all templates in the pack with key, file, scope, hostOwned flag, and hash. */
function listTemplates(): { templates: Array<{ key: string; file: string; scope: string; hostOwned: boolean; hash: string | null }> } {
  const pack = loadPack();
  return {
    templates: pack.templates.map((template) => ({
      key: template.key,
      file: template.file,
      scope: template.scope ?? "generic",
      hostOwned: template.hostOwned ?? false,
      hash: renderCanonicalHash(template),
    })),
  };
}

/** Hash of a template rendered with default vars, or null for host-owned. */
function renderCanonicalHash(template: AgentTemplate): string | null {
  if (template.hostOwned) return null;
  const defaultVars = templateVars();
  const rendered = renderInstructions(template, defaultVars);
  return renderHash(rendered);
}

/** Get a template's full details. Renders with company vars if companyId given. */
async function getTemplate(
  ctx: PluginContext,
  key: string,
  companyId?: string
): Promise<
  | { error: string }
  | {
      key: string;
      hostOwned?: true;
      stub?: true;
    }
  | {
      key: string;
      file: string;
      scope: string;
      hostOwned?: false;
      raw: string;
      rendered: string;
      renderHash: string;
      subagents?: unknown;
    }
> {
  const template = templateByKey(key);
  if (!template) {
    return { error: `unknown template "${key}"` };
  }

  if (template.hostOwned) {
    return { key, hostOwned: true, stub: true };
  }

  // Get template vars (company-specific if companyId given)
  let vars: TemplateVars;
  if (companyId) {
    const company = await getCompanyInfo(ctx, companyId);
    vars = templateVars({
      company: company.name === "the company" ? null : company.name,
      prefix: company.prefix,
      owner: null,
      ceo: null,
      wikiRoot: null,
    });
  } else {
    vars = templateVars();
  }

  const { files, blocks } = packSources();
  const raw = files[template.file];
  if (raw === undefined) {
    return { error: `template "${key}" has no instructions file` };
  }

  const rendered = renderInstructions(template, vars);
  return {
    key,
    file: template.file,
    scope: template.scope ?? "generic",
    raw,
    rendered,
    renderHash: renderHash(rendered),
    ...(template.subagents ? { subagents: template.subagents } : {}),
  };
}

/** Register the two tools with ctx.tools.register. */
export function registerTemplateTools(ctx: PluginContext): void {
  ctx.tools.register("template-list", TEMPLATE_TOOLS[0]!, async (_params, _run) => {
    try {
      const data = listTemplates();
      return { content: `Listed ${data.templates.length} templates.`, data };
    } catch (e) {
      return { error: `Failed to list templates: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  ctx.tools.register("template-get", TEMPLATE_TOOLS[1]!, async (params, run) => {
    try {
      const key = typeof params === "object" && params !== null && "key" in params ? (params as Record<string, unknown>).key : null;
      if (typeof key !== "string") {
        return { error: "key is required and must be a string" };
      }
      const companyId =
        typeof params === "object" && params !== null && "companyId" in params ? (params as Record<string, unknown>).companyId : null;
      const result = await getTemplate(ctx, key, typeof companyId === "string" ? companyId : undefined);
      if ("error" in result) {
        return { error: result.error };
      }
      const isStub = "stub" in result && result.stub;
      return {
        content: isStub ? `Template "${key}" is host-owned.` : `Template "${key}" loaded.`,
        data: result,
      };
    } catch (e) {
      return { error: `Failed to get template: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}
