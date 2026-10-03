/**
 * Starting a new client (audit Q1b-7): the CRM side.
 *
 * The CRM can only LINK a Paperclip project to a client (a plugin cannot
 * create projects or repos). The PiB procedure that creates the project, its
 * git workspace, the `development` branch policy and the agent guide is ops
 * tooling (`new-client-project.py` in `operations/vps`). What the CRM adds is
 * the contract between the two and the checklist:
 *
 * - the script (or an agent) creates the project, then calls the board action
 *   `crm.link-client-project` (tool `link-client-project`) so the project
 *   belongs to the client;
 * - `start-new-client` (tool and action `crm.start-new-client`) links a project
 *   when given one and returns what is still to do for the Delivery Lead and the
 *   Account Manager, computed from the CRM's own data. Nothing in it is a
 *   second source of truth: every line is read from the records.
 *
 * The contract, for the script:
 *
 *   POST /api/plugins/partnersinbiz.crm/actions/crm.link-client-project
 *   Authorization: Bearer <board token>
 *   { "companyId": "<Paperclip company id>", "params": { "client": "company:<crm id>", "projectId": "<project uuid>" } }
 *   -> { "data": { "projectId", "name", "client", "linked": true } }  (or "alreadyLinked": true)
 *
 *   POST /api/plugins/partnersinbiz.crm/actions/crm.find-records
 *   { "companyId": "...", "params": { "query": "<name or domain>", "kind": "company" } }
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getAccount, getContact } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { listLeadSources } from "./lead-store.js";
import { getClientProfile, type ClientProfileRecord } from "./store.js";
import { missingBrandFields, missingProfileFields, parseClientRef, requireClient, updateClientProfile } from "./lookup.js";
import { companyPrefix, crmLink, refOf, type ClientKind } from "./refs.js";
import { serviceSteps, stepsView } from "./service-onboarding.js";
import { SERVICE_KEYS, serviceDef, serviceLabel } from "./services.js";
import { clientProjects, linkClientProject, listSites } from "./sites.js";

export type StepState = "done" | "todo" | "unknown" | "waits";

export interface ChecklistStep {
  key: string;
  title: string;
  state: StepState;
  /** Who does it. */
  owner: string;
  /** The tool, action or ops tool that does it, and what to say. */
  how: string;
  detail?: string;
}

export interface NewClientState {
  client: { kind: ClientKind; id: string; name: string; lifecycle: string };
  profile: ClientProfileRecord | null;
  linkedProjects: Array<{ projectId: string; name: string; repoUrl: string | null; archived: boolean }>;
  suggestedProjects: Array<{ projectId: string; name: string }>;
  sites: number;
  leadForms: number;
  steps: Awaited<ReturnType<typeof serviceSteps>>;
}

const NEEDS_SITE = ["seo", "website", "lead-capture", "support"];

/** The checklist, from what the CRM knows (pure). Order is the order to do it in. */
export function newClientChecklist(state: NewClientState): ChecklistStep[] {
  const ref = refOf(state.client.kind, state.client.id);
  const services = state.profile?.services ?? [];
  const missing = state.profile ? missingProfileFields(state.profile) : (["brandVoice", "audience", "services", "website", "bookingLink", "bannedWords", "toneNotes"] as const);
  const brandMissing = state.profile ? missingBrandFields(state.profile) : ["logoKey", "primaryColor", "fonts", "toneExamples"];
  const customer = state.client.lifecycle === "customer";
  const steps: ChecklistStep[] = [];

  steps.push({ key: "crm-record", title: "The client is in the CRM", state: "done", owner: "Account Manager", how: `find-records / get-${state.client.kind}`, detail: `${state.client.name} (${ref})` });
  steps.push({
    key: "profile",
    title: "Fill in the client profile",
    state: missing.length === 0 ? "done" : "todo",
    owner: "Account Manager",
    how: `update-client-profile with client ${ref}`,
    ...(missing.length ? { detail: `Missing: ${missing.join(", ")}. Fill them from the proposal, the discovery notes and the client's website.` } : {}),
  });
  steps.push({
    key: "services",
    title: "Say which services the client bought",
    state: services.length > 0 || (state.profile?.servicesOther?.length ?? 0) > 0 ? "done" : "todo",
    owner: "Account Manager",
    how: `update-client-profile services (${SERVICE_KEYS.join(", ")})`,
    detail: services.length ? services.map(serviceLabel).join(", ") : "Each service a customer buys gets its own onboarding step.",
  });
  steps.push({
    key: "project",
    title: "A Paperclip project for the client's work",
    state: state.linkedProjects.length > 0 ? "done" : "todo",
    owner: "Delivery Lead",
    how: state.linkedProjects.length > 0
      ? "list-client-projects"
      : `Run the ops tool new-client-project.py (it creates the project with a git workspace and the development branch policy, then calls crm.link-client-project), or link a project that exists: link-client-project with client ${ref} and projectId.`,
    ...(state.linkedProjects.length === 0 && state.suggestedProjects.length ? { detail: `Projects that look like this client's: ${state.suggestedProjects.slice(0, 5).map((p) => `${p.name} (${p.projectId})`).join(", ")}.` } : {}),
  });
  const repo = state.linkedProjects.some((project) => project.repoUrl && !project.archived);
  steps.push({
    key: "repo",
    title: "The project has a git workspace",
    state: state.linkedProjects.length === 0 ? "waits" : repo ? "done" : "todo",
    owner: "Delivery Lead",
    how: "Open the project in Paperclip and add a workspace that is a git checkout (an issue that needs a worktree fails on a folder that is not a repo).",
  });
  steps.push({ key: "branch-policy", title: "Work happens in the development branch", state: "unknown", owner: "Delivery Lead", how: "operations/vps ensure-dev-branch.sh and gh-rulesets.sh; the project's agent guide says agents branch from development and the Delivery Lead merges there. main only changes with Peet's approval.", detail: "The CRM cannot see the repo: check it and say so on the client." });
  steps.push({ key: "agent-guide", title: "The project's agent guide (AGENTS.md)", state: "unknown", owner: "Delivery Lead", how: "Write it from the client's profile and the repo: what the client does, how to build and test, the branch rule, who approves. Link it on the client.", detail: "The CRM cannot see the repo: check it and say so on the client." });
  if (services.some((service) => NEEDS_SITE.includes(service))) {
    steps.push({
      key: "site",
      title: "The client's website is registered",
      state: state.sites > 0 ? "done" : "todo",
      owner: "Account Manager",
      how: `save-client-site with client ${ref} (a WordPress site is paired with the PiB Connector by a person on the client page, or over SFTP by an agent)`,
    });
  }
  if (services.includes("lead-capture")) {
    steps.push({ key: "lead-form", title: "A lead form for the client's site", state: state.leadForms > 0 ? "done" : "todo", owner: "Account Manager", how: `create-lead-endpoint with client ${ref}; the snippet is installed through the client's repo project` });
  }
  steps.push({
    key: "brand-kit",
    title: "The brand kit (logo, colours, fonts, tone examples)",
    state: brandMissing.length === 0 ? "done" : "todo",
    owner: "Account Manager",
    how: `update-client-profile logoKey / primaryColor / fonts / toneExamples with client ${ref}`,
    ...(brandMissing.length ? { detail: `Missing: ${brandMissing.join(", ")}. The logo is the R2 key of an image already stored for this company.` } : {}),
  });
  for (const view of stepsView(state.steps, services)) {
    const def = serviceDef(view.service);
    steps.push({
      key: `service:${view.service}`,
      title: `Start ${view.label}`,
      state: view.state === "started" || view.state === "covered" ? "done" : !customer ? "waits" : "todo",
      owner: def?.role ?? "Operator",
      how: view.issueId ? `The step is issue ${view.issueId}.` : customer ? "The daily services check opens its step (or it opens at once when the service is added)." : "It opens when the client becomes a customer.",
      ...(view.state === "covered" ? { detail: "Covered by the first-win onboarding." } : {}),
    });
  }
  steps.push({ key: "grants", title: "Every grant the client must give, in ONE ask", state: "unknown", owner: "Account Manager", how: "One ask-owner with every link and step (Search Console, social logins, site access). Never one ask per item." });
  steps.push({ key: "billing", title: "The retainer or first invoice", state: "unknown", owner: "Deal Desk", how: "Billing: draft the retainer or the first invoice; a person approves sending." });
  return steps;
}

export interface StartNewClientResult {
  client: string;
  name: string;
  lifecycle: string;
  link: string;
  project?: { projectId: string; name: string; linked: boolean; alreadyLinked: boolean };
  servicesSet?: string[];
  checklist: ChecklistStep[];
  remaining: string[];
  next: string;
}

/**
 * `start-new-client` / `crm.start-new-client`. Links the project when one is
 * given and sets the services when listed, then returns the checklist.
 */
export async function startNewClient(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human"): Promise<StartNewClientResult> {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const out: Partial<StartNewClientResult> = {};

  if (typeof params.projectId === "string" && params.projectId.trim()) {
    // The same function the board action crm.link-client-project and the link-client-project tool run.
    const linked = await linkClientProject(ctx, viewer, { client: refOf(client.kind, client.id), projectId: params.projectId });
    out.project = { projectId: linked.projectId, name: linked.name, linked: "linked" in linked && linked.linked === true, alreadyLinked: "alreadyLinked" in linked && linked.alreadyLinked === true };
  }
  if (Array.isArray(params.services) && params.services.length > 0) {
    const result = await updateClientProfile(ctx, viewer, { client: refOf(client.kind, client.id), services: params.services }, source);
    out.servicesSet = result.profile.services;
  }

  const record = client.kind === "company" ? await getAccount(ctx, client.id) : await getContact(ctx, client.id);
  if (!record || record.companyId !== viewer.companyId) throw new CrmError("The client was not found");
  const [profile, projects, sites, forms, steps, prefix] = await Promise.all([
    getClientProfile(ctx, viewer.companyId, client.kind, client.id),
    clientProjects(ctx, viewer, client, name, { candidates: true }),
    listSites(ctx, viewer.companyId, client.kind, client.id).catch(() => []),
    listLeadSources(ctx, viewer.companyId, { kind: client.kind, id: client.id }).catch(() => []),
    serviceSteps(ctx, viewer.companyId, client.kind, client.id).catch(() => []),
    companyPrefix(ctx, viewer.companyId),
  ]);
  const checklist = newClientChecklist({
    client: { kind: client.kind, id: client.id, name, lifecycle: record.lifecycle },
    profile,
    linkedProjects: projects.linked.map((project) => ({ projectId: project.projectId, name: project.name, repoUrl: project.repoUrl ?? null, archived: Boolean(project.archived) })),
    suggestedProjects: (projects.candidates ?? []).filter((project) => project.suggested).map((project) => ({ projectId: project.projectId, name: project.name })),
    sites: sites.length,
    leadForms: forms.filter((form) => form.status !== "revoked").length,
    steps,
  });
  const remaining = checklist.filter((step) => step.state !== "done").map((step) => step.title);
  return {
    client: refOf(client.kind, client.id),
    name,
    lifecycle: record.lifecycle,
    link: crmLink(prefix, client.kind, client.id),
    ...out,
    checklist,
    remaining,
    next: remaining.length === 0 ? "Everything the CRM can see is done." : `${remaining.length} still to do. Hand the project steps to the Delivery Lead (one issue in the client's project) and do the profile, services and brand kit yourself.`,
  };
}
