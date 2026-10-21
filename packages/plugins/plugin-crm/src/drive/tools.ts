import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Viewer } from "../domain.js";
import { CrmError } from "../domain.js";
import { createBroker, type DriveEntityType, BrokerError, DriveNotBoundError } from "./broker.js";
import { driveBindingDiscover, driveBindingSet, effectiveSharedDriveId } from "./binding.js";
import { planFolders, companyFolderName, DRIVE_SUBFOLDERS, type DriveFacts, type Sibling, type DriveBranch } from "./convention.js";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { table, getAccount, listAccounts, getContact, listLinks } from "../db.js";
import { getProjectDriveKind, setProjectDriveKind, listProjectDriveKinds } from "./store.js";
import { saveDriveFile, type SaveDriveFileInput, type SaveDriveFileResult } from "./save.js";

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
  {
    name: "drive_file_save",
    displayName: "Save file to Drive",
    description: "Save a file to a Paperclip project's Google Drive folder. Validates name, content, computes sha256, deduplicates, and uploads. Returns the URL. Binary-safe for base64 or local file paths (max 5 MB). Exactly one source required: contentBase64 or path.",
    parametersSchema: schema(["projectId", "fileKind", "name", "mimeType"], {
      projectId: text("The Paperclip project id (determines the Drive folder).", 100),
      fileKind: text("File kind for classification (e.g. client, product, book, marketing, company, seo, social, campaigns, ads, ops; stored in the Drive file record).", 50),
      name: text("File name: YYYY-MM-DD <what> v<n>.<ext> or <ISSUE>-<step>-<ts>.<ext> (e.g. 2026-10-20 report v1.pdf or PAR-4059-login-1760000000.png).", 300),
      mimeType: text("MIME type (e.g. application/pdf, image/png).", 100),
      contentBase64: text("File content as base64 (mutually exclusive with path). Binary-safe."),
      path: text("Absolute local file path (mutually exclusive with contentBase64). Must be inside an allowed root. Max 5 MB."),
      sha256: text("Optional: hex-encoded sha256 to verify the file content after decode/read.", 64),
      subfolder: oneOf([...DRIVE_SUBFOLDERS], "Optional: save to a sub-folder within the project's Drive folder (01 Briefs, 02 Assets, 03 Deliverables, 04 Reports, 05 Evidence, 99 Archive). Omit to save to project root."),
      requestId: text("Optional: request ID for correlation.", 100),
    }),
  },
  {
    name: "drive_project_kind_set",
    displayName: "Set project Drive kind",
    description: "Set the Drive folder kind for a Paperclip project (branch type: client, product, book, marketing, or company). Required to organize a project's Drive folder under a non-client branch or to change an existing kind. Works for projects with no client link (own projects). Records updated_by for audit.",
    parametersSchema: schema(["projectId", "kind"], { projectId: text("The project id.", 100), kind: oneOf(["client", "product", "book", "marketing", "company"], "The Drive branch kind for this project."), scopeRef: text("Optional scope reference for marketing branch (e.g., campaign name or marketing area).", 200) }),
  },
  {
    name: "drive_project_kind_list",
    displayName: "List project Drive kinds",
    description: "Read the Drive folder kinds for specified projects or all projects in the company. Returns kind and optional scopeRef for each. A client-linked project (has a client_projects row) with no kind row defaults to 'client' kind. Unlinked projects without a kind row are omitted. Company-scoped; read-only.",
    parametersSchema: schema([], { projectIds: { type: "array", items: { type: "string" }, description: "Optional list of project ids. If omitted, returns all projects for the company." } }),
  },
  {
    name: "drive_binding_discover",
    displayName: "Discover Shared Drives",
    description: "Bind this company to one of its Google Shared Drives. Call this with the list of shared drives from the company's Google Drive read connection (agent lists them, read-only: never write via the connection). Looks for an exact case-insensitive name match to the Paperclip company name. If exactly one matches, binds automatically and returns bound:true, autoPicked:true. Otherwise returns the candidates (bound:false, reason:'none'|'several') so you can call drive_binding_set with the one to use.",
    parametersSchema: schema(["drives"], { drives: { type: "array", items: { type: "object", properties: { id: text("The Shared Drive ID."), name: text("The Shared Drive name.") }, required: ["id", "name"] }, description: "List of {id, name} from the company's Shared Drive discovery." } }),
  },
  {
    name: "drive_binding_set",
    displayName: "Set Shared Drive binding",
    description: "Bind this company to a specific Shared Drive. Pass the sharedDriveId from drive_binding_discover (must be in the candidate list from the last discover call). The ID must be in the discovered list or this fails; run discover first. If the company's Shared Drive is pinned in settings, this fails with a clear message. Read-only discovery should never write.",
    parametersSchema: schema(["sharedDriveId"], { sharedDriveId: text("The Shared Drive ID from the candidate list (drive_binding_discover).", 100) }),
  },
];

export async function driveFolderResolve(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  try {
    const broker = await createBrokerForCompany(ctx, viewer.companyId);
    if (!broker) return { status: "not_configured", error: "Drive broker token is not configured in the CRM plugin settings (driveBrokerToken)" };

    const folder = await broker.resolve(type, id);
    return folder ? { status: "found", path: folder.path, url: folder.folder_url, folder_id: folder.folder_id } : { status: "not_found", hint: "call drive_folder_ensure" };
  } catch (e) {
    if (e instanceof DriveNotBoundError) {
      return { status: "drive_not_bound", hint: "Bind this company's Shared Drive in the CRM settings (drive.sharedDriveId)." };
    }
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function driveFolderEnsure(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  const include_tree = params.include_tree as boolean | undefined; // Internal param: get tree for already-ensured folders
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  let broker;
  try {
    broker = await createBrokerForCompany(ctx, viewer.companyId);
  } catch (e) {
    if (e instanceof DriveNotBoundError) {
      return { status: "drive_not_bound", hint: "Bind this company's Shared Drive in the CRM settings (drive.sharedDriveId)." };
    }
    throw e;
  }
  if (!broker) throw new CrmError("Drive broker token is not configured in the CRM plugin settings (driveBrokerToken)");

  let existing: any;
  try {
    existing = await broker.resolve(type, id);
  } catch (e) {
    if (e instanceof BrokerError) throw new CrmError(`Drive broker failed: ${e.message}`);
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // If folder exists and we don't need the tree with subfolders, return early
  if (existing && !include_tree) return { status: "exists", path: existing.path, url: existing.folder_url, folder_id: existing.folder_id, tree: [] };

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
  // Use the tree from the last step (the leaf folder) which includes subfolders
  // Fall back to accumulated tree if lastResult.tree is empty (broker may return [])
  const finalTree = lastResult.tree?.length ? lastResult.tree : tree;
  return { status: "created", path: lastResult.folder.path, url: lastResult.folder.folder_url, folder_id: lastResult.folder.folder_id, tree: finalTree };
}

export async function createBrokerForCompany(ctx: PluginContext, companyId: string) {
  const cfg = await readConfig(ctx, companyId);
  if (!cfg.driveBrokerToken) return null;

  // Get effective binding (config or state)
  const sharedDriveId = await effectiveSharedDriveId(ctx, companyId, cfg);

  // Check binding FIRST before reading token
  if (!sharedDriveId) {
    throw new DriveNotBoundError();
  }

  const resolver = new SecretResolver(ctx, companyId, cfg);
  const token = await resolver.get("driveBrokerToken");
  if (!token) return null;
  const baseUrl = (cfg.driveBrokerUrl as string) || "https://partnersinbiz.online";
  return createBroker(ctx.http.fetch, { baseUrl, token, sharedDriveId });
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
  let branch: "client" | "product" | "book" | "marketing" | "company" = "client";
  let scopeRef: string | null = null;

  // Read the project's drive_kind
  const driveKind = await getProjectDriveKind(ctx, viewer.companyId, id);
  if (driveKind) {
    branch = (driveKind.kind as any) ?? "client";
    scopeRef = driveKind.scopeRef ?? null;
  }

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
  return { entityType: "project", entityId: id, name: project.name, companyEntityId: companyId, companyName, contactName, branch, scopeRef };
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

export async function driveProjectKindSet(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const projectId = params.projectId as string;
  const kind = params.kind as string;
  const scopeRef = params.scopeRef ? (params.scopeRef as string) : undefined;

  if (!projectId) throw new CrmError("Missing projectId");
  if (!kind) throw new CrmError("Missing kind");

  const validKinds: DriveBranch[] = ["client", "product", "book", "marketing", "company"];
  if (!validKinds.includes(kind as DriveBranch)) {
    throw new CrmError(`Invalid kind: ${kind}. Must be one of: ${validKinds.join(", ")}`);
  }

  // Verify project exists in the company
  const project = await ctx.projects.get(projectId, viewer.companyId);
  if (!project) throw new CrmError("Project not found");

  const result = await setProjectDriveKind(ctx, {
    companyId: viewer.companyId,
    projectId,
    kind,
    scopeRef,
    updatedBy: viewer.userId ?? undefined,
  });

  const returnObj: any = { status: "set", projectId: result.projectId, kind: result.kind, updatedAt: result.updatedAt };
  if (result.scopeRef) returnObj.scopeRef = result.scopeRef;
  return returnObj;
}

export async function driveProjectKindList(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const projectIds = (params.projectIds as string[]) || undefined;

  // Get all kinds from the database
  const kinds = await listProjectDriveKinds(ctx, viewer.companyId, projectIds);
  const kindMap = new Map(kinds.map((k) => [k.projectId, k]));

  // If projectIds specified, we need to also get client-linked projects to apply the "client" default
  const projectsToCheck: string[] = [];
  if (projectIds) {
    projectsToCheck.push(...projectIds);
  } else {
    // Get all projects for the company
    const allProjects = await ctx.projects.list({ companyId: viewer.companyId, limit: 500 });
    projectsToCheck.push(...allProjects.map((p) => p.id));
  }

  // Build result list
  const result = [];
  for (const projId of projectsToCheck) {
    const kind = kindMap.get(projId);
    if (kind) {
      const item: any = { projectId: kind.projectId, kind: kind.kind };
      if (kind.scopeRef) item.scopeRef = kind.scopeRef;
      result.push(item);
    } else {
      // Check if project is client-linked (has a client_projects row with client_kind='company')
      const clientLink = await getCompanyLink(ctx, viewer.companyId, projId);
      if (clientLink) {
        result.push({ projectId: projId, kind: "client" });
      }
    }
  }

  return { projects: result, total: result.length };
}

export async function driveFileSave(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<SaveDriveFileResult> {
  const input: SaveDriveFileInput = {
    companyId: viewer.companyId,
    projectId: params.projectId as string,
    fileKind: params.fileKind as string,
    name: params.name as string,
    mimeType: params.mimeType as string,
    contentBase64: params.contentBase64 as string | undefined,
    path: params.path as string | undefined,
    sha256: params.sha256 as string | undefined,
    subfolder: params.subfolder as string | undefined,
    requestId: params.requestId as string | undefined,
  };

  if (!input.projectId) throw new CrmError("Missing projectId");
  if (!input.fileKind) throw new CrmError("Missing fileKind");
  if (!input.name) throw new CrmError("Missing name");
  if (!input.mimeType) throw new CrmError("Missing mimeType");

  // Verify project exists in the company
  const project = await ctx.projects.get(input.projectId, input.companyId);
  if (!project) {
    return { status: "project_not_found" };
  }

  return saveDriveFile(ctx, viewer, input);
}
