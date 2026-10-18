import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Viewer } from "../domain.js";
import { CrmError } from "../domain.js";
import { createBroker, type DriveEntityType, BrokerError } from "./broker.js";
import { planFolders, companyFolderName, type DriveFacts, type Sibling } from "./convention.js";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { table, getAccount, listAccounts, getContact, listLinks } from "../db.js";

const schema = (req: string[], props: Record<string, JsonSchema>): JsonSchema => ({ type: "object", required: req, properties: props, additionalProperties: false });
const text = (d: string, len?: number): JsonSchema => ({ type: "string", description: d, ...(len ? { maxLength: len } : {}) });
const oneOf = (vals: readonly string[], d: string): JsonSchema => ({ type: "string", enum: [...vals], description: d });

export const DRIVE_TOOLS: PluginToolDeclaration[] = [
  {
    name: "drive_folder_resolve",
    displayName: "Resolve Drive folder",
    description: "Look up the Google Drive folder (path and URL) registered for a Paperclip project or CRM company. ALWAYS call this first before saving any file to Drive. Never hard-code, guess or paste a Drive folder ID: take it from this tool's result. Read-only.",
    parametersSchema: schema(["entity_type", "entity_id"], { entity_type: oneOf(["project", "crm_company"], "The kind of entity: Paperclip project or CRM company."), entity_id: text("The entity's id: a project id or a CRM company record id.", 100) }),
  },
  {
    name: "drive_folder_ensure",
    displayName: "Ensure Drive folder",
    description: "Create (once) the standard Drive folder tree for a project or CRM company and return its path and URL. Call drive_folder_resolve first; call this only when resolve says not_found. It is safe to call again: an existing folder is returned unchanged and nothing is duplicated. Never hard-code a Drive ID. Returns needs_human_look (no folder created) when another project or company would get the same folder name — ask a human, do not retry or rename.",
    parametersSchema: schema(["entity_type", "entity_id"], { entity_type: oneOf(["project", "crm_company"], "The kind of entity: Paperclip project or CRM company."), entity_id: text("The entity's id: a project id or a CRM company record id.", 100) }),
  },
];

export async function driveFolderResolve(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  const broker = await createBrokerForCompany(ctx, viewer.companyId);
  if (!broker) return { status: "not_configured", error: "Drive broker token is not configured in the CRM plugin settings (driveBrokerToken)" };

  try {
    const folder = await broker.resolve(type, id);
    return folder ? { status: "found", path: folder.path, url: folder.folder_url, folder_id: folder.folder_id } : { status: "not_found", hint: "call drive_folder_ensure" };
  } catch (e) {
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function driveFolderEnsure(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  const broker = await createBrokerForCompany(ctx, viewer.companyId);
  if (!broker) throw new CrmError("Drive broker token is not configured in the CRM plugin settings (driveBrokerToken)");

  let existing: any;
  try {
    existing = await broker.resolve(type, id);
  } catch (e) {
    if (e instanceof BrokerError) throw new CrmError(`Drive broker failed: ${e.message}`);
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (existing) return { status: "exists", path: existing.path, url: existing.folder_url, folder_id: existing.folder_id, tree: [] };

  const facts = await loadDriveFacts(ctx, viewer, type, id);
  const siblings = await loadDriveSiblings(ctx, viewer, type, id);
  const plan = planFolders(facts, siblings, viewer.runId ?? undefined);

  if (plan.kind === "invalid_name") return { status: "invalid_name", problem: plan.problem, name: plan.name, hint: "rename the project/company to a plain human-readable name (no ID, issue key or slash) and retry" };
  if (plan.kind === "needs_human_look") return { status: "needs_human_look", reason: plan.reason, conflictsWith: plan.conflictsWith };

  const tree = [];
  let lastResult = null;
  try {
    for (const step of plan.steps) {
      const result = await broker.ensure(step);
      tree.push({ path: result.folder.path, folderId: result.folder.folder_id, created: result.created });
      lastResult = result;
    }
  } catch (e) {
    if (e instanceof BrokerError && e.retryable) {
      const details = e.folderId || e.path ? ` (folderId: ${e.folderId}) (path: ${e.path})` : "";
      throw new CrmError(`Drive broker failed part-way (retryable)${details}. Nothing was renamed or deleted. Call drive_folder_ensure again with the same arguments; it resumes and adopts what was already created (no duplicates).`);
    }
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!lastResult) throw new CrmError("No plan steps executed");
  return { status: "created", path: lastResult.folder.path, url: lastResult.folder.folder_url, folder_id: lastResult.folder.folder_id, tree };
}

async function createBrokerForCompany(ctx: PluginContext, companyId: string) {
  const cfg = await readConfig(ctx, companyId);
  if (!cfg.driveBrokerToken) return null;
  const resolver = new SecretResolver(ctx, companyId, cfg);
  const token = await resolver.get("driveBrokerToken");
  if (!token) return null;
  const baseUrl = (cfg.driveBrokerUrl as string) || "https://partnersinbiz.online";
  return createBroker(ctx.http.fetch, { baseUrl, token });
}

async function loadDriveFacts(ctx: PluginContext, viewer: Viewer, type: DriveEntityType, id: string): Promise<DriveFacts> {
  if (type === "crm_company") {
    const company = await getAccount(ctx, id);
    if (!company) throw new CrmError("company not found");
    const contact = await getPrimaryContact(ctx, viewer.companyId, id);
    return { entityType: "crm_company", entityId: id, name: company.name, contactName: contact?.name };
  }

  const project = await ctx.projects.get(id, viewer.companyId);
  if (!project) throw new CrmError("project not found");
  let companyId: string | undefined, companyName: string | undefined, contactName: string | undefined;

  const companyLink = await getCompanyLink(ctx, viewer.companyId, id);
  if (companyLink) {
    companyId = companyLink;
    const company = await getAccount(ctx, companyLink);
    if (company) {
      companyName = company.name;
      const contact = await getPrimaryContact(ctx, viewer.companyId, companyLink);
      if (contact) contactName = contact.name;
    }
  }
  return { entityType: "project", entityId: id, name: project.name, companyEntityId: companyId, companyName, contactName };
}

async function loadDriveSiblings(ctx: PluginContext, viewer: Viewer, type: DriveEntityType, id: string): Promise<Sibling[]> {
  const siblings: Sibling[] = [];
  if (type === "crm_company") {
    const companies = await listAccounts(ctx, viewer.companyId);
    for (const c of companies) {
      if (c.id !== id) {
        const contact = await getPrimaryContact(ctx, viewer.companyId, c.id);
        const folderName = companyFolderName(c.name, contact?.name);
        siblings.push({ entityType: "crm_company", entityId: c.id, name: folderName });
      }
    }
  } else {
    const companyLink = await getCompanyLink(ctx, viewer.companyId, id);
    if (companyLink) {
      const projects = await getProjectsByCompany(ctx, viewer.companyId, companyLink);
      for (const p of projects) if (p.id !== id) siblings.push({ entityType: "project", entityId: p.id, name: p.name });
      // Also add company siblings for collision detection
      const companies = await listAccounts(ctx, viewer.companyId);
      for (const c of companies) {
        if (c.id !== companyLink) {
          const contact = await getPrimaryContact(ctx, viewer.companyId, c.id);
          const folderName = companyFolderName(c.name, contact?.name);
          siblings.push({ entityType: "crm_company", entityId: c.id, name: folderName });
        }
      }
    } else {
      const allProjects = await ctx.projects.list({ companyId: viewer.companyId, limit: 500 });
      const withCompany = new Set<string>();
      const allLinks = await getAllCompanyLinks(ctx, viewer.companyId);
      for (const link of allLinks) withCompany.add(link.projectId);
      for (const p of allProjects) if (p.id !== id && !withCompany.has(p.id)) siblings.push({ entityType: "project", entityId: p.id, name: p.name });
    }
  }
  return siblings.slice(0, type === "crm_company" ? 200 : 500);
}

async function getPrimaryContact(ctx: PluginContext, companyId: string, accountId: string) {
  const links = await listLinks(ctx, companyId);
  const forAccount = links.filter((l) => l.accountId === accountId);
  if (!forAccount.length) return null;
  const primary = forAccount.find((l) => l.roleLabel === "primary") || forAccount[0];
  return await getContact(ctx, primary.contactId);
}

async function getCompanyLink(ctx: PluginContext, companyId: string, projectId: string) {
  const rows = await ctx.db.query<{ client_ref: string }>(
    `SELECT client_ref FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND project_id = $2 AND client_kind = 'company' LIMIT 1`,
    [companyId, projectId],
  );
  return rows.length ? rows[0].client_ref : null;
}

async function getProjectsByCompany(ctx: PluginContext, companyId: string, companyRef: string) {
  const rows = await ctx.db.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = 'company' AND client_ref = $2 LIMIT 200`,
    [companyId, companyRef],
  );
  const projects = [];
  for (const r of rows) {
    const p = await ctx.projects.get(r.project_id, companyId);
    if (p) projects.push(p);
  }
  return projects;
}

async function getAllCompanyLinks(ctx: PluginContext, companyId: string) {
  const rows = await ctx.db.query<{ project_id: string; client_ref: string }>(
    `SELECT DISTINCT project_id, client_ref FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = 'company'`,
    [companyId],
  );
  return rows.map((r) => ({ projectId: r.project_id, companyId: r.client_ref }));
}
