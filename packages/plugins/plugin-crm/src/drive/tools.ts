import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Viewer } from "../domain.js";
import { CrmError } from "../domain.js";
import { type Broker, type DriveEntityType, BrokerError, DriveNotBoundError } from "./broker.js";
import { driveKeyAfterAuthFailure, driveServiceAccountKey } from "./sa-secret.js";
import { createGoogleDriveBroker, CLIENTS_PATH } from "./google-broker.js";
import { parseServiceAccountKey } from "./google-sa.js";
import { driveBindingDiscover, driveBindingSet, driveBindingStatus, effectiveSharedDriveId } from "./binding.js";
import { planFolders, folderTarget, companyFolderName, DRIVE_SUBFOLDERS, type DriveFacts, type Sibling, type DriveBranch } from "./convention.js";
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import { table, getAccount, listAccounts, getContact, listLinks } from "../db.js";
import { getProjectDriveKind, setProjectDriveKind, listProjectDriveKinds, listDriveFiles } from "./store.js";
import { saveDriveFile, type SaveDriveFileInput, type SaveDriveFileResult } from "./save.js";
import { driveJobStatus, type DriveJobView } from "./jobs.js";

const schema = (req: string[], props: Record<string, JsonSchema>): JsonSchema => ({ type: "object", required: req, properties: props, additionalProperties: false });
const text = (d: string, len?: number): JsonSchema => ({ type: "string", description: d, ...(len ? { maxLength: len } : {}) });
const oneOf = (vals: readonly string[], d: string): JsonSchema => ({ type: "string", enum: [...vals], description: d });

/** Gateway budget of the tools that wait on Drive (PAR-10249); the gateway cuts a tool at 10 s otherwise. */
export const DRIVE_TOOL_TIMEOUT_MS = 25_000;

export const DRIVE_TOOLS: PluginToolDeclaration[] = [
  {
    name: "drive_folder_resolve",
    displayName: "Resolve Drive folder",
    description: "Look up the Google Drive folder (path and URL) registered for a Paperclip project or CRM company. A client's project has no folder of its own: it resolves to the client's folder (Clients/<Company (Contact)>), shared by all of that client's projects. ALWAYS call this first before saving any file to Drive. Never hard-code, guess or paste a Drive folder ID: take it from this tool's result. Read-only.",
    parametersSchema: schema(["entity_type", "entity_id"], { entity_type: oneOf(["project", "crm_company"], "The kind of entity: Paperclip project or CRM company."), entity_id: text("The entity's id: a project id or a CRM company record id.", 100) }),
  },
  {
    name: "drive_folder_ensure",
    displayName: "Ensure Drive folder",
    description: "Create (once) the standard Drive folder for a project or CRM company, with its standard sub-folders, and return its path and URL. A client's project uses the client's folder (Clients/<Company (Contact)> with Assets/Images, Assets/Video, Assets/Brand, Assets/Social, Deliverables, Contracts & Quotes, Meetings & Notes, Shared with client); a product project gets Products/<Product> (Brand, Design, Marketing assets/Images, Marketing assets/Video, App store, Shared externally). Call drive_folder_resolve first; call this only when resolve says not_found. It is safe to call again: an existing folder (also one a person made by hand) is used as it is and nothing is duplicated. Never hard-code a Drive ID. Returns needs_human_look (no folder created) when another project or company would get the same folder name — ask a human, do not retry or rename.",
    parametersSchema: schema(["entity_type", "entity_id"], { entity_type: oneOf(["project", "crm_company"], "The kind of entity: Paperclip project or CRM company."), entity_id: text("The entity's id: a project id or a CRM company record id.", 100) }),
    timeoutMs: DRIVE_TOOL_TIMEOUT_MS,
  },
  {
    name: "drive_file_save",
    displayName: "Save file to Drive",
    description: "Save a file to a Paperclip project's Google Drive folder (a client's project saves into the client's folder). Validates name, content, computes sha256, deduplicates, and uploads. Returns the URL. Binary-safe for base64 or local file paths. Exactly one source required: contentBase64 or path. Up to 5 MB the file is saved at once. Over 5 MB, path only, up to 200 MB: returns status started with a jobId; call drive_transfer_status until done. path must be inside this run's workspace or $PAPERCLIP_TMPDIR (not $TMPDIR). Dotfiles, keys and credential files are refused.",
    parametersSchema: schema(["projectId", "fileKind", "name", "mimeType"], {
      projectId: text("The Paperclip project id (determines the Drive folder).", 100),
      fileKind: text("File kind for classification (e.g. client, product, book, marketing, company, seo, social, campaigns, ads, ops; stored in the Drive file record).", 50),
      name: text("File name: YYYY-MM-DD <what> v<n>.<ext> or <ISSUE>-<step>-<ts>.<ext> (e.g. 2026-10-20 report v1.pdf or PAR-4059-login-1760000000.png).", 300),
      mimeType: text("MIME type (e.g. application/pdf, image/png).", 100),
      contentBase64: text("File content as base64 (mutually exclusive with path). Binary-safe."),
      path: text("Local file path (mutually exclusive with contentBase64), inside this run's workspace or $PAPERCLIP_TMPDIR (not $TMPDIR). Up to 200 MB; over 5 MB the save runs in the background (see drive_transfer_status). Dotfiles, keys and credential files are refused."),
      sha256: text("Optional: hex-encoded sha256 to verify the file content after decode/read.", 64),
      subfolder: oneOf([...DRIVE_SUBFOLDERS], "Optional: save to a sub-folder of the project's Drive folder. A client's folder has Assets/Images, Assets/Video, Assets/Brand, Assets/Social, Deliverables, Contracts & Quotes, Meetings & Notes, Shared with client; a product's has Brand, Design, Marketing assets/Images, Marketing assets/Video, App store, Shared externally. A name the project's folder does not have is refused (invalid_subfolder lists the real ones); book, company and marketing folders have none, so the file goes into the folder itself. Omit to save into the folder itself."),
      requestId: text("Optional: request ID for correlation.", 100),
    }),
    timeoutMs: DRIVE_TOOL_TIMEOUT_MS,
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
  {
    name: "drive_binding_status",
    displayName: "Check Shared Drive binding status",
    description: "read-only: check whether this company's Shared Drive is bound, whether the Drive service account key is set, and whether the service account is a member of the drive. Does not modify anything.",
    parametersSchema: schema([], {}),
  },
  {
    name: "drive_transfer_status",
    displayName: "Drive transfer status",
    description: "Check a Drive transfer that runs in the background. A drive_file_save over 5 MB (up to 200 MB) and every drive_file_fetch return a jobId at once; call this with that jobId until status is done (result holds the file) or failed (code and hint say why). running shows bytesDone of bytesTotal; a slow chunk is slow, not dead, so keep calling every 20-30 s. not_found: the transfer is gone (the CRM restarted); start it again, a finished copy is not made twice. Only the agent that started the transfer can see it, and a fetch only from the same run. Read-only.",
    parametersSchema: schema(["jobId"], { jobId: text("The jobId a Drive save or fetch returned.", 100) }),
  },
  {
    name: "drive_file_fetch",
    displayName: "Fetch Drive file",
    description: "Copy a file from a Paperclip project's Google Drive folder (or one of its sub-folders) into this run's scratch dir ($PAPERCLIP_TMPDIR), up to 200 MB. Always returns status started with a jobId at once; call drive_transfer_status with it every 20-30 s until it is done. Its result holds path (the local file), size, sha256, name, mimeType and runId. The file lives only as long as this run: the scratch dir is deleted when the run ends. Google Docs files are refused (export them in Drive first). Works only from a run on this server. fileId is the Google Drive file id.",
    parametersSchema: schema(["projectId", "fileId"], {
      projectId: text("The Paperclip project whose Drive folder holds the file.", 100),
      fileId: text("The Google Drive file id (from the file's Drive link), not a name or URL.", 200),
    }),
  },
  {
    name: "drive_files_list",
    displayName: "List saved Drive files",
    description: "The files the CRM saved to Drive for a Paperclip project (newest first): name, Drive link, sub-folder and the Drive id of the folder it sits in, plus the project's own Drive folder (path and link). A client's project lists into the client's folder. Use it to check that a save landed (a producer's save runs in the background, so its tool answer can time out while the file still lands). Read-only.",
    parametersSchema: schema(["projectId"], {
      projectId: text("The Paperclip project id (list-client-projects shows a client's).", 100),
      subfolder: oneOf([...DRIVE_SUBFOLDERS], "Optional: only files in this sub-folder of the project's folder."),
      nameContains: text("Optional: only files whose name contains this text (case-sensitive).", 200),
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Optional: at most this many files (default 20)." },
    }),
    timeoutMs: DRIVE_TOOL_TIMEOUT_MS,
  },
  {
    name: "drive_file_trash",
    displayName: "Trash a Drive file",
    description: "Move one file on this company's bound Shared Drive to the Drive trash (recoverable for 30 days; never a permanent delete). Pass the Google file id. Refuses a file that is not on this company's Shared Drive (not_found) and a folder unless allowFolder is true (is_folder). Trashing a file that is already in the trash is fine (alreadyTrashed). Returns id, name and trashed: true. Use it only for files a person or a decision said to remove (test proof files, canary folders); say which decision on the issue.",
    parametersSchema: schema(["fileId"], {
      fileId: text("The Google Drive file id (from the Drive link).", 200),
      allowFolder: { type: "boolean", description: "Set true to trash a folder (and everything in it), e.g. a canary folder. Default false: a folder is refused." },
    }),
    timeoutMs: DRIVE_TOOL_TIMEOUT_MS,
  },
];

/** The files saved to a project's Drive folder (PAR-7712): what a check reads to prove a save landed, without trusting the producer's answer. */
export async function driveFilesList(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (!projectId) throw new CrmError("projectId is required (list-client-projects shows a client's projects)");
  const project = await ctx.projects.get(projectId, viewer.companyId);
  if (!project) throw new CrmError("Project not found");
  const subfolder = typeof params.subfolder === "string" && params.subfolder.trim() ? params.subfolder.trim() : undefined;
  if (subfolder && !(DRIVE_SUBFOLDERS as readonly string[]).includes(subfolder)) throw new CrmError(`subfolder must be one of: ${DRIVE_SUBFOLDERS.join(", ")}`);
  const nameContains = typeof params.nameContains === "string" && params.nameContains ? params.nameContains : null;
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(Math.floor(params.limit), 100)) : 20;
  // Read wider than the limit when filtering by name, so a name match is not cut off by newer files of other names.
  const rows = await listDriveFiles(ctx, viewer.companyId, { projectId, ...(subfolder ? { subfolder } : {}), limit: nameContains ? 500 : limit });
  const files = rows
    .filter((f) => !nameContains || f.name.includes(nameContains))
    .slice(0, limit)
    .map((f) => ({ name: f.name, url: f.webUrl, subfolder: f.subfolder, folderId: f.folderId, kind: f.kind, createdAt: f.createdAt }));
  // The folder the files belong to; a Drive problem leaves it out, the stored rows still answer.
  const folder = await driveFolderResolve(ctx, viewer, { entity_type: "project", entity_id: projectId }).catch(() => null);
  return { projectId, folder, count: files.length, files };
}

export async function driveFolderResolve(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  try {
    const broker = await createBrokerForCompany(ctx, viewer.companyId);
    if (!broker) return { status: "not_configured", error: "Drive is not configured in the CRM plugin settings: set driveServiceAccountJson", ...(await notConfiguredFallback(ctx, viewer, type, id)) };

    // A client's project has no folder of its own: it is looked up as its company's folder.
    const target = await registryTarget(ctx, viewer, type, id);
    const folder = await broker.resolve(target.type, target.id);
    return folder ? { status: "found", path: folder.path, url: folder.folder_url, folder_id: folder.folder_id } : { status: "not_found", hint: "call drive_folder_ensure" };
  } catch (e) {
    if (e instanceof DriveNotBoundError) {
      return { status: "drive_not_bound", hint: "Bind this company's Shared Drive in the CRM settings (drive.sharedDriveId)." };
    }
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Where a person can file by hand when Drive is not configured: the company's Contracts & Quotes folder. Omitted when there is no client folder (product, book, no client) or the facts cannot be read. */
async function notConfiguredFallback(ctx: PluginContext, viewer: Viewer, type: DriveEntityType, id: string): Promise<{ fallback?: { sharedDriveId: string | null; pathSegments: string[] } }> {
  try {
    const facts = type === "crm_company" ? await loadDriveFacts(ctx, viewer, type, id) : await loadProjectFacts(ctx, viewer, id);
    if (!facts) return {};
    const target = folderTarget(facts);
    if (target.entityType !== "crm_company") return {};
    const name = type === "crm_company" ? facts.name : facts.companyName!;
    const sharedDriveId = await effectiveSharedDriveId(ctx, viewer.companyId, await readConfig(ctx, viewer.companyId));
    return { fallback: { sharedDriveId: sharedDriveId || null, pathSegments: [...CLIENTS_PATH, companyFolderName(name, facts.contactName), "Contracts & Quotes"] } };
  } catch {
    return {};
  }
}

/** Stage timing of one folder ensure (PAR-10249); numbers only. */
export interface EnsureTiming { resolveMs?: number; siblingsMs?: number; ensureMs?: number; ensureLockWaitMs?: number; driveLookups?: number; adoptedUntagged?: number; fast?: boolean; factsMs?: number; findSubfolderMs?: number }

export async function driveFolderEnsure(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<unknown> {
  const type = params.entity_type as DriveEntityType;
  const id = params.entity_id as string;
  const want_subfolder = typeof params.want_subfolder === "string" && params.want_subfolder ? params.want_subfolder : undefined; // Internal param (PAR-10250): one query for this sub-folder; a miss falls back to the full tree
  const include_tree = (params.include_tree as boolean | undefined) || Boolean(want_subfolder); // Internal param: get tree for already-ensured folders
  // Internal param (PAR-10249): the save fills it with this ensure's stage timing.
  const stage = params.timing && typeof params.timing === "object" ? (params.timing as EnsureTiming) : undefined;
  const clock = Date.now;
  let mark = clock();
  const lap = (): number => { const n = clock(); const d = n - mark; mark = n; return d; };
  if (type !== "project" && type !== "crm_company") throw new CrmError(`Invalid entity_type: ${type}`);
  if (!id) throw new CrmError("Missing entity_id");

  // Timing logs (PAR-10212): which step of an ensure is slow (broker set-up, the folder look-up, the plan's steps).
  const startedAt = Date.now();
  const timing = (outcome: string, extra: Record<string, unknown>) =>
    ctx.logger.info("Drive folder ensure", { companyId: viewer.companyId, entityType: type, entityId: id, includeTree: include_tree === true, outcome, elapsedMs: Date.now() - startedAt, ...extra });

  // Internal param: the save's own broker, so one save reads the config, binding and key once.
  let broker: Broker | null | undefined = params.broker && typeof params.broker === "object" ? (params.broker as Broker) : undefined;
  try {
    if (!broker) broker = await createBrokerForCompany(ctx, viewer.companyId);
  } catch (e) {
    if (e instanceof DriveNotBoundError) {
      return { status: "drive_not_bound", hint: "Bind this company's Shared Drive in the CRM settings (drive.sharedDriveId)." };
    }
    throw e;
  }
  if (!broker) throw new CrmError("Drive is not configured in the CRM plugin settings: set driveServiceAccountJson");

  // A client's project has no folder of its own: it is ensured as its company's folder, and that folder is what comes back.
  // The contact's name (it is part of the folder name) is looked up only when the folder has to be planned, not on the hot "exists" path.
  const factsStart = Date.now();
  const projectFacts = type === "project" ? await loadProjectFacts(ctx, viewer, id, false) : null;
  if (stage) stage.factsMs = Date.now() - factsStart;
  const target = projectFacts ? folderTarget(projectFacts) : { entityType: type, entityId: id };

  const brokerMs = Date.now() - startedAt;

  let existing: any;
  const resolveStartedAt = Date.now();
  lap();
  try {
    existing = await broker.resolve(target.entityType, target.entityId);
    if (stage) stage.resolveMs = lap();
  } catch (e) {
    timing("resolve_failed", { brokerMs, resolveMs: Date.now() - resolveStartedAt });
    if (e instanceof BrokerError) throw new CrmError(`Drive broker failed: ${e.message}`);
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // If the folder exists, is complete (all its standard sub-folders made) and we don't need the tree, return early.
  // An interrupted ensure leaves complete:false, and the plan below resumes it.
  const resolveMs = Date.now() - resolveStartedAt;
  if (existing && existing.complete !== false && !include_tree) {
    timing("exists", { brokerMs, resolveMs });
    return { status: "exists", path: existing.path, url: existing.folder_url, folder_id: existing.folder_id, tree: [] };
  }

  // Fast path (PAR-10250): the folder is complete and the wanted sub-folder is there, chained under it: one query, no sibling scan, no ensure.
  if (existing && existing.complete !== false && want_subfolder && broker.findSubfolder) {
    const findStart = Date.now();
    const hit = await broker.findSubfolder(target.entityType, target.entityId, want_subfolder, existing.folder_id);
    if (stage) stage.findSubfolderMs = Date.now() - findStart;
    if (hit) {
      if (stage) stage.fast = true;
      timing("exists_subfolder", { brokerMs, resolveMs });
      return { status: "exists", path: existing.path, url: existing.folder_url, folder_id: existing.folder_id, tree: [{ path: `${existing.path}/${want_subfolder}`, folderId: hit.folder_id }] };
    }
  }

  let facts = type === "project" ? projectFacts : await loadDriveFacts(ctx, viewer, type, id);
  if (!facts) throw new CrmError("project not found");
  if (type === "project" && facts.companyEntityId && facts.companyName) {
    facts = { ...facts, contactName: (await getPrimaryContact(ctx, viewer.companyId, facts.companyEntityId))?.name };
  }
  // Collisions are checked for the folder that is actually made: a client's project is checked as its company (against the other companies).
  lap();
  const siblings = await loadDriveSiblings(ctx, viewer, target.entityType, target.entityId);
  if (stage) stage.siblingsMs = lap();
  const plan = planFolders(facts, siblings, viewer.runId ?? undefined);

  if (plan.kind === "invalid_name") return { status: "invalid_name", problem: plan.problem, name: plan.name, hint: "rename the project/company to a plain human-readable name (no ID, issue key or slash) and retry" };
  if (plan.kind === "needs_human_look") return { status: "needs_human_look", reason: plan.reason, conflictsWith: plan.conflictsWith };

  let lastResult = null;
  const ensureStartedAt = Date.now();
  try {
    for (const step of plan.steps) {
      lastResult = await broker.ensure(step);
      if (stage && lastResult.stats) {
        stage.ensureLockWaitMs = (stage.ensureLockWaitMs ?? 0) + lastResult.stats.lockWaitMs;
        stage.driveLookups = (stage.driveLookups ?? 0) + lastResult.stats.driveLookups;
        stage.adoptedUntagged = (stage.adoptedUntagged ?? 0) + lastResult.stats.adoptedUntagged;
      }
    }
    if (stage) stage.ensureMs = lap();
  } catch (e) {
    timing("ensure_failed", { brokerMs, resolveMs, steps: plan.steps.length, ensureMs: Date.now() - ensureStartedAt });
    if (e instanceof BrokerError && e.retryable) {
      const details = e.folderId || e.path ? ` (folderId: ${e.folderId}) (path: ${e.path})` : "";
      throw new CrmError(`Drive broker failed part-way (retryable)${details}. Nothing was renamed or deleted. Call drive_folder_ensure again with the same arguments; it resumes and adopts what was already created (no duplicates).`);
    }
    throw new CrmError(`Drive broker failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  timing("ensured", { brokerMs, resolveMs, steps: plan.steps.length, ensureMs: Date.now() - ensureStartedAt, existed: Boolean(existing) });
  if (!lastResult) throw new CrmError("No plan steps executed");
  // The tree is the leaf folder's standard sub-folders, and nothing else: a book, company or marketing folder has none, so its tree is
  // empty (the steps above it, the layout folders, are not part of what a save can choose from).
  return { status: "created", path: lastResult.folder.path, url: lastResult.folder.folder_url, folder_id: lastResult.folder.folder_id, tree: lastResult.tree ?? [] };
}

export async function createBrokerForCompany(ctx: PluginContext, companyId: string) {
  const cfg = await readConfig(ctx, companyId);
  if (!cfg.driveServiceAccountJson) return null;

  // Get effective binding (config or state)
  const sharedDriveId = await effectiveSharedDriveId(ctx, companyId, cfg);

  // Check binding FIRST before reading the secret
  if (!sharedDriveId) {
    throw new DriveNotBoundError();
  }

  // Cached per company (PAR-9358): the host allows 30 secret lookups a minute for the whole plugin.
  const serviceAccountJson = await driveServiceAccountKey(ctx, companyId, cfg);
  if (!serviceAccountJson) return null;
  return withKeyRefresh(ctx, companyId, cfg, serviceAccountJson, sharedDriveId);
}

const isBadCredential = (e: unknown): boolean => e instanceof BrokerError && (e.code === "bad_credential" || e.status === 401);

/** Methods whose input can be sent again: a stream (upload chunks, a download body) is used once and is never retried. */
const REPLAYABLE = ["resolve", "findSubfolder", "ensure", "identity", "uploadFile", "listFiles", "fileMeta", "trashFile", "downloadFile", "thumbnail"] as const;
const ONE_SHOT = ["uploadFileStream", "downloadStream"] as const;

/**
 * The broker on the cached key. When Google refuses the key, the secret is read once more; a different key (rotated
 * since it was cached) gets one retry of a replayable call. A streamed call is not retried, but the next call uses the new key.
 */
function withKeyRefresh(ctx: PluginContext, companyId: string, cfg: Record<string, unknown>, keyJson: string, sharedDriveId: string): Broker {
  let currentKey = keyJson;
  let inner = createGoogleDriveBroker(fetch, parseServiceAccountKey(keyJson), sharedDriveId);
  const refresh = async (): Promise<boolean> => {
    const next = await driveKeyAfterAuthFailure(ctx, companyId, cfg, currentKey);
    if (!next) return false;
    currentKey = next;
    inner = createGoogleDriveBroker(fetch, parseServiceAccountKey(next), sharedDriveId);
    return true;
  };
  const broker: Record<string, unknown> = {};
  for (const name of REPLAYABLE) {
    if (typeof (inner as unknown as Record<string, unknown>)[name] !== "function") continue;
    broker[name] = async (...args: unknown[]) => {
      const call = () => ((inner as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name])(...args);
      try {
        return await call();
      } catch (e) {
        if (!isBadCredential(e) || !(await refresh())) throw e;
        return call();
      }
    };
  }
  for (const name of ONE_SHOT) {
    if (typeof (inner as unknown as Record<string, unknown>)[name] !== "function") continue;
    broker[name] = async (...args: unknown[]) => {
      try {
        return await ((inner as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name])(...args);
      } catch (e) {
        if (isBadCredential(e)) await refresh().catch(() => false);
        throw e;
      }
    };
  }
  return broker as unknown as Broker;
}

/**
 * The project whose Drive folder a producer plugin's save lands in. A client's save goes to the
 * project linked to that client (the one of the same kind when there is one, e.g. the SEO project
 * for an SEO file, else the oldest); the company's own work goes to `drive.ownProjectId`, but only when the producer
 * asked for it (`ownWork`), so a save that lost its client is refused, never filed as ours (PAR-8128). A save that names
 * a Paperclip project (`projectId`, e.g. the issue's) lands there only when that project is linked to a client or is
 * the own project; the link decides, not the producer.
 */
export async function resolveProducerSaveProject(
  ctx: PluginContext,
  companyId: string,
  input: { kind?: string; clientKind?: string; clientRef?: string; ownWork?: boolean; projectId?: string },
): Promise<string | null> {
  const ownProject = async (): Promise<string | null> => {
    const cfg = await readConfig(ctx, companyId);
    const own = (cfg.drive as { ownProjectId?: unknown } | undefined)?.ownProjectId;
    return typeof own === "string" && own.trim() ? own.trim() : null;
  };
  if (input.projectId) {
    const linked = await ctx.db.query<{ project_id: string }>(
      `SELECT project_id FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND project_id = $2 LIMIT 1`,
      [companyId, input.projectId],
    );
    if (linked.length) return input.projectId;
    return (await ownProject()) === input.projectId ? input.projectId : null;
  }
  if (input.clientKind && input.clientRef) {
    if (input.clientKind !== "company" && input.clientKind !== "contact") return null;
    const rows = await ctx.db.query<{ project_id: string; kind: string | null }>(
      `SELECT project_id, kind FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at ASC LIMIT 50`,
      [companyId, input.clientKind, input.clientRef],
    );
    if (!rows.length) return null;
    return (rows.find((r) => r.kind && r.kind === input.kind) ?? rows[0]).project_id;
  }
  return input.ownWork === true ? ownProject() : null;
}

/** The registry key of the folder an entity saves into: for a client's project the company's, otherwise the entity itself (also when the project is unknown). */
async function registryTarget(ctx: PluginContext, viewer: Viewer, type: DriveEntityType, id: string): Promise<{ type: DriveEntityType; id: string }> {
  if (type !== "project") return { type, id };
  const facts = await loadProjectFacts(ctx, viewer, id, false);
  if (!facts) return { type, id };
  const target = folderTarget(facts);
  return { type: target.entityType, id: target.entityId };
}

async function loadDriveFacts(ctx: PluginContext, viewer: Viewer, type: DriveEntityType, id: string): Promise<DriveFacts> {
  if (type === "crm_company") {
    const company = await getAccount(ctx, id);
    if (!company) throw new CrmError("company not found");
    const contact = await getPrimaryContact(ctx, viewer.companyId, id);
    return { entityType: "crm_company", entityId: id, name: company.name, contactName: contact?.name };
  }
  const facts = await loadProjectFacts(ctx, viewer, id);
  if (!facts) throw new CrmError("project not found");
  return facts;
}

/** What decides a project's folder: its name, its Drive kind and the company it is linked to (with its primary contact, which names the folder, unless `withContact` is false). Null when the project does not exist. */
async function loadProjectFacts(ctx: PluginContext, viewer: Viewer, id: string, withContact = true): Promise<DriveFacts | null> {
  const project = await ctx.projects.get(id, viewer.companyId);
  if (!project) return null;
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
      if (withContact) {
        const contact = await getPrimaryContact(ctx, viewer.companyId, companyLink);
        if (contact) contactName = contact.name;
      }
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
    `SELECT client_ref FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND project_id = $2 AND client_kind = 'company' ORDER BY created_at ASC, client_ref ASC LIMIT 1`,
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

export function driveTransferStatus(viewer: Viewer, params: Record<string, unknown>): DriveJobView {
  return driveJobStatus({ companyId: viewer.companyId, agentId: viewer.agentId, runId: viewer.runId ?? null }, params.jobId);
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

const TRASH_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/** `drive_file_trash` (PAR-11108): Drive trash for one file on the company's Shared Drive. Logs one activity entry per trash. */
export async function driveFileTrash(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, deps: { brokerFor?: (ctx: PluginContext, companyId: string) => Promise<Broker | null> } = {}): Promise<unknown> {
  const fileId = typeof params.fileId === "string" ? params.fileId.trim() : "";
  if (!TRASH_FILE_ID.test(fileId)) return { status: "invalid_input", hint: "fileId is a Google Drive file id (letters, digits, - and _)." };
  const allowFolder = params.allowFolder === true;
  try {
    const broker = await (deps.brokerFor ?? createBrokerForCompany)(ctx, viewer.companyId);
    if (!broker) return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    if (!broker.trashFile) return { status: "not_supported", hint: "This Drive connection can't trash files." };
    const r = await broker.trashFile(fileId, { allowFolder });
    if (r.status === "not_found") return { status: "not_found", hint: "No such file on this company's Shared Drive." };
    if (r.status !== "trashed") return { status: "is_folder", hint: "That is a folder. Pass allowFolder: true to trash it and everything in it." };
    if (!r.alreadyTrashed) {
      await ctx.activity.log({
        companyId: viewer.companyId,
        message: `Moved Drive file "${r.name}" to the trash`,
        entityType: "drive_file",
        entityId: r.id,
        metadata: { agentId: viewer.agentId, runId: viewer.runId ?? null, fileId: r.id, name: r.name, mimeType: r.mimeType, allowFolder },
      }).catch((e: unknown) => ctx.logger.warn("drive_file_trash activity log failed", { error: e instanceof Error ? e.message : String(e) }));
    }
    return { id: r.id, name: r.name, trashed: true, ...(r.alreadyTrashed ? { alreadyTrashed: true } : {}) };
  } catch (e) {
    if (e instanceof DriveNotBoundError) return { status: "drive_not_bound", hint: "Bind Drive in CRM settings (drive.sharedDriveId)." };
    if (e instanceof BrokerError) return { status: "broker_error", hint: `Google Drive refused the trash (${e.status}).`, retryable: e.retryable };
    throw e;
  }
}
