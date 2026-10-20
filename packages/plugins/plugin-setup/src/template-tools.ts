/**
 * Setup agent tools: template-list, template-get, template-preview.
 * Pure declarations and handlers (no I/O except company lookup in get).
 */
import type { JsonSchema, PluginContext, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { loadPack, packSources, templateByKey, templateVars, type AgentTemplate, type TemplateVars } from "./templates.js";
import { renderInstructions } from "./templates-render.js";
import { renderHash } from "./render-hash.js";
import { varsFor } from "./new-company.js";
import { subagentExtraArgs, type SubagentPolicy } from "./subagents.js";
import { applyUnifiedDiff } from "./unified-diff.js";

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

/** Extract string from unknown, or null. */
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
  {
    name: "template-preview",
    displayName: "Preview template change",
    description:
      "Dry-run a proposed edit to a template: apply a unified diff to the template's raw source in memory (nothing is saved), and return the rendered candidate with default variables and its render hash. Rejects a diff that does not apply cleanly. Host-owned templates return a stub with no raw/rendered/hash. Read-only.",
    parametersSchema: schema(["key", "unifiedDiff"], {
      key: { type: "string", description: "The template key from template-list" },
      unifiedDiff: { type: "string", description: "A unified diff against the raw source returned by template-get" },
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


type TemplateGetResult =
  | { error: string }
  | { key: string; hostOwned: true }
  | {
      key: string;
      file: string;
      scope: string;
      hostOwned: false;
      raw: string;
      rendered: string;
      renderHash: string;
      subagents?: SubagentPolicy;
      extraArgs?: string[];
    };

type TemplatePreviewResult =
  | { error: string }
  | { key: string; hostOwned: true }
  | {
      key: string;
      hostOwned: false;
      raw: string;
      rendered: string;
      renderHash: string;
      baseRenderHash: string;
      changed: boolean;
    };

/** Get a template's full details. Renders with company vars if companyId given. */
async function getTemplate(ctx: PluginContext, key: string, companyId?: string): Promise<TemplateGetResult> {
  const template = templateByKey(key);
  if (!template) {
    return { error: `unknown template "${key}"` };
  }

  if (template.hostOwned) {
    return { key, hostOwned: true };
  }

  // Get template vars: use varsFor if companyId given, otherwise defaults.
  // varsFor returns an explicit found flag to check if the company exists.
  let vars: TemplateVars;
  if (companyId) {
    const varsResult = await varsFor(ctx, { companyId, key: null });
    if (!varsResult.found) {
      return { error: `company "${companyId}" not found` };
    }
    vars = varsResult.vars;
  } else {
    vars = templateVars();
  }

  const { files } = packSources();
  const raw = files[template.file];
  if (raw === undefined) {
    return { error: `template "${key}" has no instructions file` };
  }

  const rendered = renderInstructions(template, vars);
  const extraArgs = subagentExtraArgs(template.subagents);
  const result: {
    key: string;
    file: string;
    scope: string;
    hostOwned: false;
    raw: string;
    rendered: string;
    renderHash: string;
    subagents?: SubagentPolicy;
    extraArgs?: string[];
  } = {
    key,
    file: template.file,
    scope: template.scope ?? "generic",
    hostOwned: false,
    raw,
    rendered,
    renderHash: renderHash(rendered),
  };

  if (template.subagents) {
    result.subagents = template.subagents;
  }
  if (extraArgs.length > 0) {
    result.extraArgs = extraArgs;
  }

  return result;
}

/** Preview a template with a unified diff applied. */
async function previewTemplate(ctx: PluginContext, key: string, unifiedDiff: string): Promise<TemplatePreviewResult> {
  const template = templateByKey(key);
  if (!template) {
    return { error: `unknown template "${key}"` };
  }

  if (template.hostOwned) {
    return { key, hostOwned: true };
  }

  // Get the raw text
  const { files } = packSources();
  const raw = files[template.file];
  if (raw === undefined) {
    return { error: `template "${key}" has no instructions file` };
  }

  // Render the original to get baseRenderHash
  const defaultVars = templateVars();
  const baseRendered = renderInstructions(template, defaultVars);
  const baseRenderHash = renderHash(baseRendered);

  // Apply the diff to get patched raw text
  const diffResult = applyUnifiedDiff(raw, unifiedDiff);
  if (!diffResult.ok) {
    return { error: `diff does not apply cleanly: ${diffResult.error}` };
  }

  const patchedRaw = diffResult.text;

  // Render the patched template using renderInstructions with rawOverride
  const rendered = renderInstructions(template, defaultVars, patchedRaw);
  const renderHashValue = renderHash(rendered);
  const changed = rendered !== baseRendered;

  return {
    key,
    hostOwned: false,
    raw: patchedRaw,
    rendered,
    renderHash: renderHashValue,
    baseRenderHash,
    changed,
  };
}

/** Register the two tools with ctx.tools.register. */
export function registerTemplateTools(ctx: PluginContext): { templateList: any; templateGet: any; templatePreview: any } {
  const templateList = async (_params: unknown, _run: any) => {
    try {
      const data = listTemplates();
      return { content: `Listed ${data.templates.length} templates.`, data };
    } catch (e) {
      return { error: `Failed to list templates: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  const templateGet = async (params: unknown, run: any) => {
    try {
      const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const key = str(p.key);
      if (!key) {
        return { error: "key is required and must be a string" };
      }

      // Default companyId to run.companyId; reject if different.
      const passedCompanyId = str(p.companyId);
      const runCompanyId = typeof run?.companyId === "string" ? run.companyId : null;
      const companyId = passedCompanyId || runCompanyId || undefined;

      // If a companyId was explicitly passed and it differs from run.companyId, reject it.
      if (passedCompanyId && runCompanyId && passedCompanyId !== runCompanyId) {
        return { error: `companyId must match the current run company` };
      }

      const result = await getTemplate(ctx, key, companyId);
      if ("error" in result) {
        return { error: result.error };
      }
      const isHostOwned = result.hostOwned === true;
      return {
        content: isHostOwned ? `Template "${key}" is host-owned.` : `Template "${key}" loaded.`,
        data: result,
      };
    } catch (e) {
      return { error: `Failed to get template: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  const templatePreview = async (params: unknown, run: any) => {
    try {
      const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const key = str(p.key);
      if (!key) {
        return { error: "key is required and must be a string" };
      }
      const unifiedDiff = str(p.unifiedDiff);
      if (!unifiedDiff) {
        return { error: "unifiedDiff is required and must be a string" };
      }

      const result = await previewTemplate(ctx, key, unifiedDiff);
      if ("error" in result) {
        return { error: result.error };
      }
      const isHostOwned = result.hostOwned === true;
      return {
        content: isHostOwned ? `Template "${key}" is host-owned.` : `Template "${key}" preview rendered.`,
        data: result,
      };
    } catch (e) {
      return { error: `Failed to preview template: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  ctx.tools.register("template-list", TEMPLATE_TOOLS[0]!, templateList);
  ctx.tools.register("template-get", TEMPLATE_TOOLS[1]!, templateGet);
  ctx.tools.register("template-preview", TEMPLATE_TOOLS[2]!, templatePreview);

  return { templateList, templateGet, templatePreview };
}
