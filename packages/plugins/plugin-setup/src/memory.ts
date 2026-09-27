/**
 * Company wiki (upstream LLM Wiki plugin): pure helpers, no node imports.
 *
 * LLM Wiki does not push a `setup.status`, and the Setup worker cannot see
 * its folder, agent or routines. So the Setup page (board session) reads them
 * from the host, boils them down to a `WikiSnapshot`, and reports the snapshot
 * to the worker (`setup.report-memory`). Both sides turn a snapshot into the
 * checklist with `memoryStatus`, so the page and the weekly Finish setup issue
 * always show the same items.
 */
import { MODULES, SETUP_PLUGIN, type SetupItem, type SetupStatus } from "./kit-setup.js";

export const WIKI_PLUGIN = "paperclipai.plugin-llm-wiki";
export const WIKI_PLUGIN_NAME = "LLM Wiki";

/** Setup-page actions for Company wiki (run by the page, not a worker). */
export const MEMORY_ACTION = "memory.setup";

/** LLM Wiki pages (Paperclip paths without the company prefix). */
export const WIKI_LINKS = {
  home: "/wiki",
  settings: "/wiki/settings",
  routines: "/wiki/settings/routines",
  events: "/wiki/settings/events",
} as const;

/** The three managed routines LLM Wiki declares (all created paused, triggers off). */
export const WIKI_ROUTINES = [
  { key: "cursor-window-processing", title: "Process LLM Wiki updates", schedule: "every 6 hours" },
  { key: "nightly-wiki-lint", title: "Run LLM Wiki lint", schedule: "nightly" },
  { key: "index-refresh", title: "Refresh LLM Wiki index", schedule: "hourly" },
] as const;

export type WikiRoutineKey = (typeof WIKI_ROUTINES)[number]["key"];

/** Agent statuses that mean "this agent runs". */
const RUNNING_STATUSES = new Set(["active", "idle", "running"]);

export interface WikiSnapshot {
  checkedAt: string;
  /** Null = could not read. */
  folder: { configured: boolean; healthy: boolean; path: string | null; problems: string[] } | null;
  /** Null = could not read; `id: null` = no Wiki Maintainer in this company yet. */
  agent: { id: string | null; name: string | null; status: string | null; adapterType: string | null; urlKey: string | null } | null;
  /** Other agents in the company that run (CEO first). Null = could not read. */
  peers: Array<{ id: string; name: string; adapterType: string | null; role: string | null }> | null;
  /** One entry per `WIKI_ROUTINES` key. Null = could not read. */
  routines: Array<{ key: string; title: string; routineId: string | null; status: string | null; triggersEnabled: boolean | null }> | null;
  eventIngestion: { enabled: boolean; sources: { issues: boolean; comments: boolean; documents: boolean } } | null;
  /** Default wiki folder for "Do it for me": `<instance>/companies/<companyId>/wiki`. */
  suggestedFolderPath: string | null;
}

// ---------------------------------------------------------------------------
// Parsing host responses into a snapshot
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function list(value: unknown): Rec[] {
  const root = rec(value);
  const raw = Array.isArray(value) ? value : root ? (root.data ?? root.items) : null;
  return Array.isArray(raw) ? raw.map(rec).filter((row): row is Rec => row !== null) : [];
}

/** `{ data: X }` → X (host bridge responses), anything else as is. */
export function unwrapData(body: unknown): unknown {
  const root = rec(body);
  return root && "data" in root && rec(root.data) ? root.data : body;
}

function parseFolder(value: unknown): WikiSnapshot["folder"] {
  const folder = rec(value);
  if (!folder || bool(folder.configured) === null) return null;
  const problems = Array.isArray(folder.problems)
    ? folder.problems
      .map((problem) => (typeof problem === "string" ? problem : str(rec(problem)?.message)))
      .filter((text): text is string => !!text)
      .slice(0, 5)
    : [];
  return { configured: folder.configured === true, healthy: folder.healthy === true, path: str(folder.path), problems };
}

function parseAgent(value: unknown): WikiSnapshot["agent"] {
  const resource = rec(value);
  if (!resource) return null;
  const id = str(resource.agentId) ?? str(resource.id);
  const details = rec(resource.details) ?? rec(resource.agent) ?? resource;
  if (!id) {
    // Only trust "not created" when the resource says so.
    if (str(resource.status) === "missing" || "agentId" in resource) return { id: null, name: null, status: null, adapterType: null, urlKey: null };
    return null;
  }
  return {
    id,
    name: str(details.name),
    status: str(details.status),
    adapterType: str(details.adapterType),
    urlKey: str(details.urlKey),
  };
}

function parseIngestion(value: unknown): WikiSnapshot["eventIngestion"] {
  const settings = rec(value);
  if (!settings || bool(settings.enabled) === null) return null;
  const sources = rec(settings.sources) ?? {};
  return {
    enabled: settings.enabled === true,
    sources: { issues: sources.issues === true, comments: sources.comments === true, documents: sources.documents === true },
  };
}

/** Every string anywhere in a value (for adapter config paths). */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 500) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out, depth + 1);
  return out;
}

/**
 * `<instance>/companies/<companyId>/wiki`, found from any agent's adapter
 * config (instruction paths live under the company folder). Null when no
 * agent has such a path.
 */
export function suggestWikiFolder(agents: unknown, companyId: string): string | null {
  if (!companyId) return null;
  const segment = `/companies/${companyId}/`;
  for (const agent of list(agents)) {
    for (const text of strings(agent.adapterConfig)) {
      const at = text.indexOf(segment);
      if (at <= 0) continue;
      // The absolute path that ends in the company segment (the string may be a whole command line).
      const match = text.slice(0, at + segment.length).match(/(?:^|[\s="'])(\/[^"']*)$/);
      const path = match?.[1] ?? null;
      if (path && !path.includes("..")) return `${path}wiki`;
    }
  }
  return null;
}

/** Agents that run, other than the maintainer: CEO first, then by name. */
export function runningPeers(agents: unknown, maintainerId: string | null): NonNullable<WikiSnapshot["peers"]> {
  return list(agents)
    .filter((agent) => str(agent.id) && agent.id !== maintainerId && RUNNING_STATUSES.has(String(agent.status)))
    .map((agent) => ({ id: agent.id as string, name: str(agent.name) ?? (agent.id as string), adapterType: str(agent.adapterType), role: str(agent.role) }))
    .sort((a, b) => Number(b.role === "ceo") - Number(a.role === "ceo") || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function routineMatches(routine: Rec, key: string, title: string, knownId: string | null): boolean {
  if (knownId && routine.id === knownId) return true;
  const managed = rec(routine.managedByPlugin);
  if (managed && managed.pluginKey === WIKI_PLUGIN) return managed.resourceKey === key;
  return !knownId && routine.title === title;
}

function parseRoutines(managed: unknown, companyRoutines: unknown | null): WikiSnapshot["routines"] {
  const resolutions = Array.isArray(managed) ? managed.map(rec).filter((row): row is Rec => row !== null) : null;
  const rows = companyRoutines === null ? null : list(companyRoutines);
  if (!resolutions && !rows) return null;
  return WIKI_ROUTINES.map(({ key, title }) => {
    const resolution = resolutions?.find((row) => row.resourceKey === key) ?? null;
    const knownId = resolution ? str(resolution.routineId) : null;
    const row = rows?.find((routine) => routineMatches(routine, key, title, knownId)) ?? null;
    const routineId = knownId ?? str(row?.id) ?? null;
    const status = str(row?.status) ?? str(rec(resolution?.routine)?.status) ?? null;
    let triggersEnabled: boolean | null = null;
    if (row && Array.isArray(row.triggers)) {
      const triggers = row.triggers.map(rec).filter((trigger): trigger is Rec => trigger !== null && trigger.archived !== true);
      triggersEnabled = triggers.length > 0 && triggers.every((trigger) => trigger.enabled === true);
    }
    return { key, title, routineId, status: routineId ? status : null, triggersEnabled: routineId ? triggersEnabled : null };
  });
}

/**
 * A snapshot from what the page could read. `wiki` is LLM Wiki's `settings`
 * data (or its `/overview` route when settings could not be read); `agents`
 * and `routines` are the host's company lists (null when they failed).
 */
export function wikiSnapshotFrom(input: { companyId: string; wiki: unknown; agents: unknown | null; routines: unknown | null; now?: Date }): WikiSnapshot {
  const wiki = rec(unwrapData(input.wiki)) ?? {};
  let agent = parseAgent(wiki.managedAgent);
  const agentRows = input.agents === null ? null : list(input.agents);
  // The company list is fresher than the plugin's cached details.
  const fresh = agent?.id && agentRows ? agentRows.find((row) => row.id === agent!.id) : null;
  if (agent && fresh) {
    agent = { ...agent, name: str(fresh.name) ?? agent.name, status: str(fresh.status) ?? agent.status, adapterType: str(fresh.adapterType) ?? agent.adapterType, urlKey: str(fresh.urlKey) ?? agent.urlKey };
  }
  const peerSource = agentRows ?? (Array.isArray(wiki.agentOptions) ? wiki.agentOptions : null);
  return {
    checkedAt: (input.now ?? new Date()).toISOString(),
    folder: parseFolder(wiki.folder),
    agent,
    peers: peerSource ? runningPeers(peerSource, agent?.id ?? null) : null,
    routines: parseRoutines(wiki.managedRoutines, input.routines),
    eventIngestion: parseIngestion(wiki.eventIngestion),
    suggestedFolderPath: agentRows ? suggestWikiFolder(agentRows, input.companyId) : null,
  };
}

/** A snapshot sent by the page (worker side): same shape, re-checked field by field. */
export function parseWikiSnapshot(value: unknown): WikiSnapshot | null {
  const raw = rec(value);
  if (!raw) return null;
  const checkedAt = str(raw.checkedAt);
  const agent = rec(raw.agent);
  const routines = Array.isArray(raw.routines) ? raw.routines.map(rec).filter((row): row is Rec => row !== null) : null;
  const peers = Array.isArray(raw.peers) ? raw.peers.map(rec).filter((row): row is Rec => row !== null && !!str(row.id)) : null;
  const path = str(raw.suggestedFolderPath);
  return {
    checkedAt: checkedAt && !Number.isNaN(Date.parse(checkedAt)) ? checkedAt : new Date().toISOString(),
    folder: parseFolder(raw.folder),
    agent: agent
      ? { id: str(agent.id), name: str(agent.name), status: str(agent.status), adapterType: str(agent.adapterType), urlKey: str(agent.urlKey) }
      : null,
    peers: peers
      ? peers.slice(0, 10).map((peer) => ({ id: peer.id as string, name: str(peer.name) ?? (peer.id as string), adapterType: str(peer.adapterType), role: str(peer.role) }))
      : null,
    routines: routines
      ? WIKI_ROUTINES.map(({ key, title }) => {
        const row = routines.find((candidate) => candidate.key === key);
        return { key, title, routineId: str(row?.routineId), status: str(row?.status), triggersEnabled: bool(row?.triggersEnabled) };
      })
      : null,
    eventIngestion: parseIngestion(raw.eventIngestion),
    suggestedFolderPath: path && path.startsWith("/") && !path.includes("..") ? path : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot → checklist
// ---------------------------------------------------------------------------

export interface MemorySetupParams {
  /** Configure (or repair) the wiki folder at this path. */
  folderPath?: string;
  /** Create missing wiki routines, set them active, switch their schedules on. */
  routines?: boolean;
  /** Turn on Paperclip event ingestion (issues, comments, documents). */
  ingestion?: boolean;
}

function memoryAction(label: string, params: MemorySetupParams): NonNullable<SetupItem["action"]> {
  return { plugin: SETUP_PLUGIN, key: MEMORY_ACTION, label, params: params as Record<string, unknown> };
}

const AGENT_NEXT = {
  folder: "The wiki becomes the company's readable knowledge base: pages per client, project and topic, distilled from finished work. Agents' per-task memory (the Cockpit brief) works without it.",
  agent: "The Wiki Maintainer turns finished work into wiki pages, lints the wiki nightly and keeps the index current.",
  routines: "Every 6 hours the Maintainer distils recent work into the wiki, every night it lints it, every hour it refreshes the index.",
  ingestion: "New issues, comments and documents are recorded for the Maintainer, so finished work reaches the wiki without anyone asking.",
};

function routinesDone(snapshot: WikiSnapshot | null): boolean {
  return !!snapshot?.routines && snapshot.routines.every((r) => r.routineId && r.status === "active" && r.triggersEnabled === true);
}

function ingestionDone(snapshot: WikiSnapshot | null): boolean {
  const ingestion = snapshot?.eventIngestion;
  return !!ingestion?.enabled && (ingestion.sources.issues || ingestion.sources.comments || ingestion.sources.documents);
}

function folderItem(snapshot: WikiSnapshot | null, reason: string): SetupItem {
  const base = {
    key: "wiki_folder",
    title: "Connect the wiki folder",
    required: true,
    href: WIKI_LINKS.home,
    hrefLabel: "Open the wiki",
    agentNext: AGENT_NEXT.folder,
  };
  const folder = snapshot?.folder ?? null;
  if (!folder) return { ...base, status: "unknown", detail: reason };
  if (folder.configured && folder.healthy) return { ...base, status: "done", detail: folder.path ? `Wiki folder: ${folder.path}` : undefined };
  if (folder.configured) {
    return {
      ...base,
      status: "missing",
      detail: `The wiki folder${folder.path ? ` at ${folder.path}` : ""} is not ready${folder.problems.length ? `: ${folder.problems.join("; ")}` : "."}`,
      steps: ["Open the wiki.", "Check the folder path, then click Repair & bootstrap.", "Come back here and check again."],
      action: folder.path ? memoryAction("Repair the wiki folder", { folderPath: folder.path }) : null,
    };
  }
  const path = snapshot?.suggestedFolderPath ?? null;
  const rest: MemorySetupParams = {};
  if (!routinesDone(snapshot)) rest.routines = true;
  if (!ingestionDone(snapshot)) rest.ingestion = true;
  return {
    ...base,
    status: "missing",
    detail: path
      ? `The wiki has no folder yet. "Set up company memory" creates it at ${path}, creates the Wiki Maintainer and its routines, turns the routines on and switches on distilling of finished work.`
      : "The wiki has no folder yet. Pick an absolute folder on the Paperclip server, for example next to this company's agent folders.",
    steps: [
      "Open the wiki (it opens on \"Choose a wiki root folder\").",
      path ? `Enter ${path} (or another absolute folder on the Paperclip server).` : "Enter an absolute folder on the Paperclip server, e.g. <instance>/companies/<company id>/wiki.",
      "Click Configure & bootstrap. This also creates the Wiki Maintainer agent and its routines.",
    ],
    action: path ? memoryAction("Set up company memory", { folderPath: path, ...rest }) : null,
  };
}

function adapterLabel(adapter: string | null): string {
  return adapter ?? "no adapter";
}

function agentItem(snapshot: WikiSnapshot | null, reason: string): SetupItem {
  const agent = snapshot?.agent ?? null;
  const peers = snapshot?.peers ?? null;
  const peerAdapters = peers ? [...new Set(peers.map((peer) => peer.adapterType).filter((a): a is string => !!a))] : null;
  const reference = peers?.find((peer) => peer.adapterType) ?? null;
  const referenceText = reference ? `${reference.adapterType} (what ${reference.name}${reference.role === "ceo" ? ", your CEO," : ""} uses)` : null;
  const base = {
    key: "wiki_agent",
    title: "Give the Wiki Maintainer a working adapter and turn it on",
    required: true,
    agentNext: AGENT_NEXT.agent,
  };
  if (!agent) return { ...base, status: "unknown", detail: reason, href: WIKI_LINKS.settings, hrefLabel: "Open wiki settings" };
  if (!agent.id) {
    return {
      ...base,
      status: "missing",
      detail: "There is no Wiki Maintainer agent in this company yet. Setting up the wiki folder creates it.",
      href: WIKI_LINKS.settings,
      hrefLabel: "Open wiki settings",
      steps: ["Set up the wiki folder first (it creates the agent), or click \"Create the Wiki Maintainer\".", "Then give it a working adapter and resume it."],
      action: { plugin: WIKI_PLUGIN, key: "reconcile-managed-agent", label: "Create the Wiki Maintainer" },
    };
  }
  const problems: string[] = [];
  const adapterWrong = !!peerAdapters && peerAdapters.length > 0 && (!agent.adapterType || !peerAdapters.includes(agent.adapterType));
  if (adapterWrong) problems.push(`It uses ${adapterLabel(agent.adapterType)}, but the agents that run in this company use ${peerAdapters!.join(", ")}.`);
  const status = agent.status;
  if (status === "paused") problems.push("It is paused (LLM Wiki creates it paused).");
  else if (status === "error") problems.push("Its last run failed, usually because its adapter or model does not work here.");
  else if (status === "terminated") problems.push("It was terminated.");
  else if (status === "pending_approval") problems.push("It is waiting for approval.");
  else if (!status || !RUNNING_STATUSES.has(status)) problems.push(`Its status is ${status ?? "unknown"}.`);
  const href = `/agents/${agent.urlKey ?? agent.id}`;
  if (problems.length === 0) {
    return { ...base, status: "done", detail: `${agent.name ?? "Wiki Maintainer"} runs on ${adapterLabel(agent.adapterType)}.`, href, hrefLabel: "Open the agent" };
  }
  const candidates = (peers ?? []).slice(0, 3).map((peer) => peer.name);
  const steps = [
    `Open ${agent.name ?? "the Wiki Maintainer"} → Configuration.`,
    referenceText
      ? `Set the adapter to ${referenceText} and pick the same model that agent uses.`
      : "Pick the adapter and model that work in this company (the ones your CEO uses).",
    "Save, then click Resume.",
  ];
  if (candidates.length > 0) {
    steps.push(`Or let an agent that already runs keep the wiki: Wiki → Settings → Setup → Maintainer, pick one (e.g. ${candidates.join(", ")}) and save.`);
  }
  return {
    ...base,
    status: "missing",
    detail: problems.join(" "),
    href,
    hrefLabel: "Open the agent",
    steps,
  };
}

function routinesItem(snapshot: WikiSnapshot | null, reason: string): SetupItem {
  const base = {
    key: "wiki_routines",
    title: "Turn on the wiki routines",
    required: true,
    href: WIKI_LINKS.routines,
    hrefLabel: "Open wiki routines",
    agentNext: AGENT_NEXT.routines,
    blockedBy: ["wiki_agent"],
  };
  const routines = snapshot?.routines ?? null;
  if (!routines) return { ...base, status: "unknown", detail: reason };
  if (routinesDone(snapshot)) return { ...base, status: "done", detail: "Distil (every 6 hours), lint (nightly) and index refresh (hourly) are on." };
  const missing = routines.filter((r) => !r.routineId);
  const paused = routines.filter((r) => r.routineId && r.status !== "active");
  const triggersOff = routines.filter((r) => r.routineId && r.triggersEnabled === false);
  const triggersUnknown = routines.filter((r) => r.routineId && r.triggersEnabled === null);
  const names = (rows: typeof routines) => rows.map((r) => `${r.title} (${WIKI_ROUTINES.find((w) => w.key === r.key)?.schedule ?? ""})`).join(", ");
  const parts: string[] = [];
  if (missing.length) parts.push(`Not created yet: ${names(missing)}.`);
  if (paused.length) parts.push(`Paused: ${names(paused)}.`);
  if (triggersOff.length) parts.push(`Schedule off: ${names(triggersOff)}.`);
  if (!missing.length && !paused.length && !triggersOff.length && triggersUnknown.length) {
    return { ...base, status: "unknown", detail: `The routines are active, but Setup could not read their schedules: ${names(triggersUnknown)}.` };
  }
  return {
    ...base,
    status: "missing",
    detail: `LLM Wiki creates its routines paused with their schedules off. ${parts.join(" ")}`,
    steps: [
      "Open Wiki → Settings → Managed Routines.",
      ...(missing.length ? ["Click Repair / reconcile so all three routines exist."] : []),
      "Set each of the three routines to Active.",
      "Open each routine and switch its schedule trigger on.",
    ],
    action: memoryAction("Turn the routines on", { routines: true }),
  };
}

function ingestionItem(snapshot: WikiSnapshot | null, reason: string): SetupItem {
  const base = {
    key: "event_ingestion",
    title: "Distil finished work automatically",
    required: false,
    href: WIKI_LINKS.events,
    hrefLabel: "Open ingestion settings",
    agentNext: AGENT_NEXT.ingestion,
  };
  const ingestion = snapshot?.eventIngestion ?? null;
  if (!ingestion) return { ...base, status: "unknown", detail: reason };
  if (ingestionDone(snapshot)) {
    const on = (Object.keys(ingestion.sources) as Array<keyof typeof ingestion.sources>).filter((key) => ingestion.sources[key]);
    return { ...base, status: "done", detail: `Recording ${on.join(", ")} for the Maintainer.` };
  }
  return {
    ...base,
    status: "optional",
    detail: "Recommended. Paperclip event ingestion is off by default: without it, finished issues, comments and documents are not recorded for the Maintainer to distil.",
    steps: ["Open Wiki → Settings → Ingestion Settings.", "Turn event ingestion on with issues, comments and documents.", "Click Save controls."],
    action: memoryAction("Turn it on", { ingestion: true }),
  };
}

/**
 * The Company wiki checklist. `null` snapshot (never checked, or LLM Wiki
 * unreachable) → every item `unknown` with `reason`.
 */
export function memoryStatus(snapshot: WikiSnapshot | null, options: { reason?: string; version?: string | null } = {}): SetupStatus {
  const reason = options.reason ?? "Setup could not read this from LLM Wiki. Open the Setup page to check again.";
  return {
    plugin: WIKI_PLUGIN,
    module: "memory",
    title: MODULES.memory.title,
    version: options.version ?? null,
    items: [folderItem(snapshot, reason), agentItem(snapshot, reason), routinesItem(snapshot, reason), ingestionItem(snapshot, reason)],
    checkedAt: snapshot?.checkedAt ?? new Date().toISOString(),
  };
}

/** Stand-in used when the page never reported Company wiki for a company. */
export const MEMORY_NOT_CHECKED = "Not checked yet. Open the Setup page once and it checks Company wiki for you.";

export function isMemoryAction(action: SetupItem["action"] | null | undefined): boolean {
  return !!action && action.plugin === SETUP_PLUGIN && action.key === MEMORY_ACTION;
}

export function memorySetupParams(params: Record<string, unknown> | undefined): MemorySetupParams {
  const source = params ?? {};
  const out: MemorySetupParams = {};
  const path = str(source.folderPath);
  if (path && path.startsWith("/") && !path.includes("..")) out.folderPath = path;
  if (source.routines === true) out.routines = true;
  if (source.ingestion === true) out.ingestion = true;
  return out;
}
