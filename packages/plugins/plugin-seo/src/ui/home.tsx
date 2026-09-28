/**
 * The SEO home (every sprint: our own sites first, then each client's) and a
 * client's SEO list, plus the dialogs that start a sprint or its 90-day plan.
 * Every figure comes from the worker's overview (service/overview.ts), so the
 * tiles agree with the sprint page, the CRM card and the Cockpit.
 */
import { useEffect, useMemo, useState } from "react";
import { DataTable, useHostNavigation, usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { parseClientParam, type ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";
import {
  Building2,
  Button,
  CalendarCheck,
  CircleAlert,
  CompactRows,
  EmptyState,
  Field,
  HeartPulse,
  Input,
  KpiCard,
  Modal,
  ProgressBar,
  Rocket,
  SectionCard,
  Select,
  TextArea,
  Toolbar,
  UserRound,
  breakAnywhere,
  errorText,
  fluidColumns,
  formatShortDate,
  tokens,
  useIsNarrow,
} from "@partnersinbiz/pib-plugin-ui";
import { DUE_TERMS, projectFixPath, stuckText } from "../engine/due.js";
import { suggestBusinessType } from "../engine/business-type.js";
import { fixPlurals, lowerFirst, plural } from "../engine/plain.js";
import { BUSINESS_TYPES, PLANS, type BusinessType } from "../templates/plans.js";
import { readCrmProfile } from "./crm-profile.js";
import { StatePill, quietLink, shortUrl, small, type LinkProps } from "./parts.js";
import { TEAM_SETUP_HREF } from "./role-skills.js";
import type { LoadResult, ScopeClient, SprintSummary } from "./types.js";
import { nextLine, sprintBadge, sprintStatusText, tasksLine } from "./words.js";

const RUNNING = ["pre_launch", "active", "compounding"];
const grid = (min: number, gap = 16) => ({ display: "grid", gap, gridTemplateColumns: fluidColumns(min), minWidth: 0 }) as const;

/** Plain names of the business types, for the plan pickers. */
export const BUSINESS_TYPE_OPTIONS: Record<BusinessType, string> = {
  local: "Local service business (guest house, clinic, club, trades)",
  professional: "Professional services (law firm, accountant, consultancy)",
  ecommerce: "Online shop",
  saas: "Software (SaaS)",
};

function isActive(s: SprintSummary): boolean {
  return !s.legacy && RUNNING.includes(s.status);
}

function siteUrlFromDomain(domain: string | null | undefined): string {
  if (!domain || domain.includes("@") || !domain.includes(".")) return "";
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

interface Group {
  key: string;
  title: string;
  /** `company:<id>` for a client group, null for our own sites. */
  client: string | null;
  sprints: SprintSummary[];
}

/** Our own sites first, then each client (by name). */
export function groupSprints(sprints: SprintSummary[]): Group[] {
  const own: Group = { key: "own", title: "Our own sites", client: null, sprints: [] };
  const clients = new Map<string, Group>();
  for (const sprint of sprints) {
    if (!sprint.client) {
      own.sprints.push(sprint);
      continue;
    }
    const group = clients.get(sprint.client) ?? { key: sprint.client, title: sprint.clientName ?? "Client", client: sprint.client, sprints: [] };
    group.sprints.push(sprint);
    clients.set(sprint.client, group);
  }
  return [own, ...[...clients.values()].sort((a, b) => a.title.localeCompare(b.title))];
}

function sumNumbers(sprints: SprintSummary[]) {
  const out = { due: 0, overdue: 0, stuck: 0, stuckRuns: 0, waitingOnYou: 0, runsProjectIds: [] as string[] };
  for (const s of sprints.filter(isActive)) {
    out.due += s.tasks?.due ?? 0;
    out.overdue += s.tasks?.overdue ?? 0;
    out.stuck += s.tasks?.stuck ?? 0;
    out.stuckRuns += s.tasks?.stuckRuns ?? 0;
    out.waitingOnYou += s.tasks?.waitingOnYou ?? 0;
    for (const id of s.tasks?.runsProjectIds ?? []) if (!out.runsProjectIds.includes(id)) out.runsProjectIds.push(id);
  }
  return out;
}

export function SprintHome({
  data,
  client,
  onOpen,
  onCreate,
  onStartPlan,
}: {
  data: LoadResult;
  client: ScopeClient | null;
  onOpen: (sprint: SprintSummary) => void;
  onCreate: () => void;
  onStartPlan: (sprint: SprintSummary) => void;
}) {
  const nav = useHostNavigation();
  const narrow = useIsNarrow();
  const [query, setQuery] = useState("");
  const live = data.sprints.filter((s) => s.status !== "archived");
  const archived = data.sprints.filter((s) => s.status === "archived");
  const active = live.filter(isActive);
  const noPlan = live.filter((s) => s.legacy).length;
  const sum = sumNumbers(live);
  const scores = active.map((s) => s.health?.score).filter((v): v is number => typeof v === "number");
  const lowest = scores.length ? Math.round(Math.min(...scores)) : null;
  const q = query.trim().toLowerCase();
  const shown = q ? live.filter((s) => `${s.siteName} ${s.siteUrl} ${s.clientName ?? ""} ${s.legacyClientName ?? ""}`.toLowerCase().includes(q)) : live;
  const groups = client ? [{ key: "client", title: "SEO sprints", client: null, sprints: shown }] : groupSprints(shown);

  if (data.sprints.length === 0) {
    return (
      <EmptyState
        icon={Rocket}
        title={client ? `No SEO sprint for ${client.name} yet` : "No SEO sprints yet"}
        description="A sprint is one site's 90-day plan, matched to the kind of business: a local service business, professional services, an online shop or software. The SEO agent works it; you only do what needs a person."
        action={<Button type="button" disabled={Boolean(client && !client.known)} onClick={onCreate}>+ New sprint</Button>}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={grid(150, 10)}>
        <KpiCard label="Active sprints" value={active.length} icon={Rocket} hint={noPlan ? `${plural(noPlan, "sprint")} without a plan yet` : `${plural(live.length, "sprint")} in total`} />
        <KpiCard label="Due now" value={sum.due} icon={CalendarCheck} tone={sum.overdue ? "warn" : undefined} hint={sum.overdue ? `${sum.overdue} overdue` : "None overdue"} />
        <KpiCard label="Needs you" value={sum.waitingOnYou} icon={UserRound} tone={sum.waitingOnYou ? "warn" : undefined} hint={sum.waitingOnYou ? "Grants, sign-offs and approvals" : "Nothing waiting"} />
        {sum.stuck ? (
          <KpiCard
            label="Stuck"
            value={sum.stuck}
            icon={CircleAlert}
            tone="bad"
            hint={`${stuckText(sum, data.agent)}: ${sum.stuck > sum.stuckRuns ? "fix in Setup" : "fix the project"}`}
            link={nav.linkProps(sum.stuck > sum.stuckRuns ? TEAM_SETUP_HREF : projectFixPath(sum.runsProjectIds))}
          />
        ) : (
          <KpiCard label="Lowest health" value={lowest ?? "—"} icon={HeartPulse} hint={lowest == null ? "After the first weekly review" : "Weekly review score, out of 100"} />
        )}
      </div>
      <details style={{ fontSize: 12.5, color: tokens.muted, marginTop: -6 }}>
        <summary style={{ cursor: "pointer", minHeight: 24 }}>What these numbers mean</summary>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 2, lineHeight: 1.5, listStyle: "disc" }}>
          <li>{DUE_TERMS.due}</li>
          <li>{DUE_TERMS.overdue}</li>
          <li>{DUE_TERMS.stuck}</li>
          <li>Needs you: the sprint's Needs you items, plus changes waiting for your approval.</li>
          <li>Active: a running sprint with its 90-day plan. The Cockpit and the client's CRM page count the same way.</li>
        </ul>
      </details>
      {live.length > 6 ? <Toolbar search={query} onSearchChange={setQuery} searchPlaceholder="Search sprints…" /> : null}
      {groups.map((group) => (
        <SprintGroup key={group.key} group={group} narrow={narrow} onOpen={onOpen} onStartPlan={onStartPlan} linkFor={nav.linkProps} />
      ))}
      {archived.length > 0 ? (
        <details style={{ fontSize: 13 }}>
          <summary style={{ cursor: "pointer", color: tokens.muted, minHeight: 32 }}>Archived sprints ({archived.length})</summary>
          <div style={{ marginTop: 8 }}>
            <CompactRows
              rows={archived}
              rowKey={(s) => s.sprintId}
              title={(s) => s.siteName}
              meta={(s) => [s.clientName ?? "Our own site", s.plan].join(" · ")}
              onOpen={onOpen}
              label="Archived sprints"
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SprintGroup({ group, narrow, onOpen, onStartPlan, linkFor }: {
  group: Group;
  narrow: boolean;
  onOpen: (s: SprintSummary) => void;
  onStartPlan: (s: SprintSummary) => void;
  linkFor: (to: string) => LinkProps;
}) {
  const sum = sumNumbers(group.sprints);
  const workspace = group.client ? parseClientParam(group.client) : null;
  return (
    <SectionCard
      title={group.title}
      subtitle={group.sprints.length ? `${plural(group.sprints.length, "sprint")} · ${tasksLine(sum)}` : "No sprint yet"}
      icon={group.client ? Building2 : Rocket}
      actions={workspace ? <a {...linkFor(`/seo?client=${encodeURIComponent(group.client!)}`)} style={quietLink}>Client's SEO →</a> : null}
    >
      {group.sprints.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>No sprint for our own sites yet.</p>
      ) : narrow ? (
        <CompactRows
          rows={group.sprints}
          rowKey={(s) => s.sprintId}
          title={(s) => s.siteName}
          meta={(s) => {
            // The pill shows the state; this line says what comes next.
            const next = nextLine(s.next);
            if (s.legacy || !next) return `${sprintStatusText(s)}${s.legacy ? "" : " · nothing due"}`;
            return `Next: ${next.title}`;
          }}
          trailing={(s) => {
            const badge = sprintBadge(s);
            return <StatePill label={badge.label} tone={badge.tone} />;
          }}
          onOpen={onOpen}
          label={`${group.title}: sprints`}
        />
      ) : (
        <DataTable
          columns={[
            {
              key: "siteName",
              header: "Site",
              render: (_v, row) => {
                const s = row as unknown as SprintSummary;
                return (
                  <button type="button" onClick={() => onOpen(s)} style={{ all: "unset", cursor: "pointer", display: "grid", gap: 2, minWidth: 0, maxWidth: "100%" }}>
                    <strong style={{ fontSize: 13.5, ...breakAnywhere }}>{s.siteName}</strong>
                    <span style={{ fontSize: 12, color: tokens.muted, ...breakAnywhere }}>{shortUrl(s.siteUrl)}</span>
                    {s.legacyClientName ? <span style={{ fontSize: 12, color: tokens.muted }}>Names “{s.legacyClientName}”, not linked to the CRM</span> : null}
                  </button>
                );
              },
            },
            {
              key: "day",
              header: "Plan",
              render: (_v, row) => {
                const s = row as unknown as SprintSummary;
                const day = Math.min(Math.max(s.day, 0), 90);
                return (
                  <span style={{ display: "grid", gap: 4, minWidth: 120 }}>
                    <span style={{ fontSize: 12.5 }}>{sprintStatusText(s)}</span>
                    {isActive(s) ? <ProgressBar value={day / 90} size="xs" ariaLabel={`Day ${day} of 90`} /> : null}
                    <span style={{ fontSize: 12, color: tokens.muted }}>{s.legacy ? "Pick a plan to start" : s.plan}</span>
                  </span>
                );
              },
            },
            {
              key: "next",
              header: "Next thing due",
              render: (_v, row) => {
                const s = row as unknown as SprintSummary;
                if (s.legacy) return <Button type="button" variant="secondary" style={small} onClick={() => onStartPlan(s)}>Start the 90-day plan</Button>;
                const next = nextLine(s.next);
                if (!next) return <span style={{ fontSize: 12.5, color: tokens.muted }}>Nothing due</span>;
                return (
                  <span style={{ display: "grid", gap: 2, minWidth: 0, maxWidth: 360 }}>
                    <span style={{ fontSize: 13, ...breakAnywhere }}>{next.title}</span>
                    <span style={{ fontSize: 12, color: tokens.muted }}>{next.label}{next.dueDate ? ` · due ${formatShortDate(next.dueDate)}` : ""}</span>
                  </span>
                );
              },
            },
            {
              key: "status",
              header: "Status",
              render: (_v, row) => {
                const s = row as unknown as SprintSummary;
                const badge = sprintBadge(s);
                return (
                  <span style={{ display: "grid", gap: 4, justifyItems: "start" }}>
                    <StatePill label={badge.label} tone={badge.tone} />
                    {s.legacy ? null : <span style={{ fontSize: 12, color: tokens.muted }}>{tasksLine(s.tasks)}</span>}
                  </span>
                );
              },
            },
          ]}
          rows={group.sprints.map((s) => ({ ...s, id: s.sprintId }))}
          emptyMessage="No sprints match."
        />
      )}
    </SectionCard>
  );
}

type CrmClientOption = { client: string; kind: "company" | "contact"; id: string; name: string; detail: string | null };

function BusinessTypeField({ value, onChange, hint, required }: { value: BusinessType | ""; onChange: (value: BusinessType) => void; hint?: string; required?: boolean }) {
  const plan = value ? PLANS[value] : null;
  return (
    <Field label="Kind of business (sets the 90-day plan)">
      <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
        <Select value={value} required={required} onChange={(e) => onChange(e.target.value as BusinessType)} style={{ width: "100%" }}>
          {value ? null : <option value="">Choose the kind of business…</option>}
          {BUSINESS_TYPES.map((type) => <option key={type} value={type}>{BUSINESS_TYPE_OPTIONS[type]}</option>)}
        </Select>
        {plan ? <span style={{ fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 }}>{plan.summary}</span> : null}
        {hint ? <span style={{ fontSize: 12, color: tokens.muted }}>{hint}</span> : null}
      </div>
    </Field>
  );
}

/**
 * New sprint. In a client's workspace it is that client's; on the SEO home a
 * person picks our own site or a CRM client. The kind of business comes from
 * the client's CRM profile (services and website) when there is one, else a
 * client starts as a local service business; our own sites ask.
 */
export function CreateSprintModal({ open, data, client, companyId, onClose, onCreated, onError }: {
  open: boolean;
  data: LoadResult;
  client: ScopeClient | null;
  companyId: string;
  onClose: () => void;
  onCreated: (sprintId: string, scope: ClientRef | null, note: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const create = usePluginAction("seo.create-sprint");
  const listClients = usePluginAction("seo.clients");
  const fixedClient: ClientRef | null = client ? { kind: client.kind, id: client.id } : null;
  const [forClient, setForClient] = useState<string>("own");
  const [clients, setClients] = useState<CrmClientOption[] | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType | "">("");
  const [chosenByPerson, setChosenByPerson] = useState(false);
  const [hint, setHint] = useState("");
  const [startDate, setStartDate] = useState(data.today);
  const [owner, setOwner] = useState<"me" | "none">("me");
  const [mode, setMode] = useState(data.settings.defaultAutopilotMode);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const chosen: ClientRef | null = fixedClient ?? (forClient === "own" ? null : parseClientParam(forClient));
  const chosenKey = chosen ? `${chosen.kind}:${chosen.id}` : "own";

  // A fresh form each time it opens.
  useEffect(() => {
    if (!open) return;
    setForClient(fixedClient ? `${fixedClient.kind}:${fixedClient.id}` : "own");
    setSiteUrl(siteUrlFromDomain(client?.domain));
    setSiteName(client?.name ?? "");
    setBusinessType(fixedClient ? "local" : "");
    setChosenByPerson(false);
    setHint("");
    setStartDate(data.today);
    setOwner("me");
    setMode(data.settings.defaultAutopilotMode);
    setNotes("");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The home page offers our own site or any CRM client.
  useEffect(() => {
    if (!open || fixedClient || clients) return;
    listClients({})
      .then((result) => setClients((result as { clients: CrmClientOption[] }).clients))
      .catch(() => setClients([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The plan follows the client's CRM profile unless the person picked one.
  useEffect(() => {
    if (!open) return;
    if (!chosen) {
      if (!chosenByPerson) setBusinessType("");
      setHint("Pick the kind of business for our own site.");
      return;
    }
    let live = true;
    setHint("Reading the client's CRM profile…");
    void readCrmProfile(companyId, chosen).then((profile) => {
      if (!live) return;
      const guess = profile ? suggestBusinessType(profile) : null;
      if (!chosenByPerson) setBusinessType(guess?.type ?? "local");
      setHint(
        guess
          ? `Suggested from the client's CRM profile (it mentions “${guess.word}”). Change it if it does not fit.`
          : "Nothing in the CRM profile says otherwise, so it starts as a local service business. Change it if it does not fit.",
      );
      if (profile?.website) setSiteUrl((current) => current || siteUrlFromDomain(profile.website));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chosenKey]);

  function pickClient(value: string) {
    setForClient(value);
    const option = clients?.find((c) => c.client === value) ?? null;
    setSiteName(option?.name ?? "");
    setSiteUrl(siteUrlFromDomain(option?.detail));
    setChosenByPerson(false);
  }

  const plan = businessType ? PLANS[businessType] : null;
  async function submit() {
    if (!businessType) return;
    setSaving(true);
    setError("");
    try {
      const result = (await create({
        client: chosen ? `${chosen.kind}:${chosen.id}` : null,
        siteUrl,
        siteName: siteName || undefined,
        businessType,
        startDate,
        owner,
        autopilotMode: mode,
        notes: notes || undefined,
      })) as { sprintId: string; issuesOpened: number; warnings: string[]; plan?: string };
      const warnings = result.warnings.map(fixPlurals).join(" ");
      await onCreated(result.sprintId, chosen, `Sprint created on the ${lowerFirst(result.plan ?? plan?.label ?? "90-day")} plan: ${plural(result.issuesOpened, "task")} opened.${warnings ? ` ${warnings}` : ""}`);
    } catch (e) {
      setError(errorText(e));
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const clientName = client?.name ?? clients?.find((c) => c.client === forClient)?.name ?? null;
  return (
    <Modal
      open={open}
      title={clientName ? `New SEO sprint for ${clientName}` : "New SEO sprint"}
      description={plan ? `Seeds the ${lowerFirst(plan.label)} plan (${plan.tasks.length} tasks, ${plan.sources.length} directories and profiles), creates the sprint issue and opens what is due.` : "The kind of business decides the 90-day plan: its tasks, directories and profiles."}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={saving || !siteUrl.trim() || !businessType || (client ? !client.known : false)} onClick={() => void submit()}>
            {saving ? "Creating…" : "Create sprint"}
          </Button>
        </>
      )}
    >
      {client ? (
        <Field label="For">
          <span style={{ fontSize: 13 }}>{client.name} <span style={{ color: tokens.muted }}>· {client.kind === "company" ? "CRM company" : "CRM contact"}{client.domain ? ` · ${client.domain}` : ""}</span></span>
        </Field>
      ) : (
        <Field label="Who is it for?">
          <Select value={forClient} onChange={(e) => pickClient(e.target.value)} style={{ width: "100%" }}>
            <option value="own">Our own site (Partners in Biz)</option>
            {(clients ?? []).map((c) => <option key={c.client} value={c.client}>{c.name}{c.detail ? ` · ${c.detail}` : ""}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Site URL"><Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.co.za" required /></Field>
      <Field label="Site name"><Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder={clientName ?? "Default: the domain"} /></Field>
      <BusinessTypeField value={businessType} onChange={(v) => { setBusinessType(v); setChosenByPerson(true); }} hint={hint} required />
      <Field label="Start date (day 0)"><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
      <Field label="Owner (gets sign-offs and the weekly Needs you list)">
        <Select value={owner} onChange={(e) => setOwner(e.target.value as "me" | "none")} style={{ width: "100%" }}>
          <option value="me">Me</option>
          <option value="none">No owner</option>
        </Select>
      </Field>
      <Field label="Autopilot">
        <Select value={mode} onChange={(e) => setMode(e.target.value)} style={{ width: "100%" }}>
          <option value="safe">Safe: the agent works; publishing needs your sign-off</option>
          <option value="full">Full: the agent finishes its tasks</option>
          <option value="off">Off: every task goes to the owner</option>
        </Select>
      </Field>
      <Field label="Notes for the agent (site access, who deploys)"><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. WordPress admin access via 1Password 'Client site'; the developer deploys code changes" /></Field>
      {error ? <p style={{ margin: 0, color: tokens.destructive, fontSize: 13 }}>{error}</p> : null}
    </Modal>
  );
}

/** An old sprint without the 90-day plan: pick the kind of business, then seed its plan. */
export function StartPlanModal({ sprint, onClose, onStarted, onError }: {
  sprint: SprintSummary | null;
  onClose: () => void;
  onStarted: (sprint: SprintSummary, note: string) => Promise<void>;
  onError: (m: string) => void;
}) {
  const upgrade = usePluginAction("seo.upgrade-legacy");
  const [type, setType] = useState<BusinessType | "">("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setType(sprint?.client ? "local" : "");
  }, [sprint?.sprintId, sprint?.client]);
  const plan = useMemo(() => (type ? PLANS[type] : null), [type]);
  if (!sprint) return null;
  async function start() {
    if (!sprint || !type) return;
    setSaving(true);
    try {
      const result = (await upgrade({ sprintId: sprint.sprintId, businessType: type })) as { plan?: string; seededTasks: number };
      await onStarted(sprint, `The ${lowerFirst(result.plan ?? plan?.label ?? "90-day")} plan is set: ${plural(result.seededTasks, "task")} added. The next daily run opens the ones that are due.`);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open
      title="Start the 90-day plan"
      description={`${sprint.siteName} has no plan yet. The kind of business decides its tasks, directories and profiles.`}
      onClose={onClose}
      footer={(
        <>
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={!type || saving} onClick={() => void start()}>{saving ? "Starting…" : "Start the plan"}</Button>
        </>
      )}
    >
      <BusinessTypeField value={type} onChange={setType} required hint={sprint.client ? "Most clients are local service businesses." : undefined} />
    </Modal>
  );
}

export { BusinessTypeField };
