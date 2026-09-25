import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DataTable,
  MetricCard,
  StatusBadge,
  useHostNavigation,
  usePluginAction,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  BarChart,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Page,
  Select,
  StatRow,
  Tabs,
  Toolbar,
  errorText,
} from "@partnersinbiz/pib-plugin-ui";

interface Sprint { id: string; name: string; site_url: string }
interface Keyword { id: string; phrase: string; rank: number | null }
interface Audit { id: string; finding: string; severity: string }
type TabId = "overview" | "sprints" | "keywords";
type CreateKind = "sprint" | "keyword" | "task" | null;

export function SeoPage({ context }: PluginPageProps) {
  const load = usePluginAction("seo.load");
  const createSprint = usePluginAction("seo.create-sprint");
  const recordRank = usePluginAction("seo.record-rank");
  const openTask = usePluginAction("seo.open-task");
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<TabId>("overview");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState<CreateKind>(null);
  const [name, setName] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [sprintId, setSprintId] = useState("");
  const [phrase, setPhrase] = useState("");
  const [task, setTask] = useState("");

  async function refresh() {
    const snapshot = (await load({})) as { sprints: Sprint[]; keywords: Keyword[]; audits: Audit[] };
    setSprints(snapshot.sprints);
    setKeywords(snapshot.keywords);
    setAudits(snapshot.audits);
  }

  useEffect(() => {
    if (!context.companyId) return;
    refresh().catch((error: unknown) => setMessage(errorText(error)));
  }, [context.companyId]);

  async function run(work: () => Promise<unknown>, success: string) {
    setMessage("");
    try {
      await work();
      await refresh();
      setMessage(success);
      setCreate(null);
    } catch (error) {
      setMessage(errorText(error));
    }
  }

  const q = search.trim().toLowerCase();
  const sprintRows = useMemo(() => sprints.filter((row) => !q || `${row.name} ${row.site_url}`.toLowerCase().includes(q)), [sprints, q]);
  const keywordRows = useMemo(() => keywords.filter((row) => !q || row.phrase.toLowerCase().includes(q)), [keywords, q]);
  const bySeverity = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const audit of audits) counts[audit.severity] = (counts[audit.severity] ?? 0) + 1;
    return counts;
  }, [audits]);

  return (
    <Page
      title="SEO"
      description="A sprint is one site. Work for a person becomes a Paperclip issue tagged with that sprint."
      message={message}
      actions={<Button type="button" onClick={() => setCreate("sprint")}>+ Sprint</Button>}
    >
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "sprints", label: `Sprints (${sprints.length})` },
          { id: "keywords", label: `Keywords (${keywords.length})` },
        ]}
        active={tab}
        onChange={(id) => { setTab(id as TabId); setSearch(""); }}
      />

      {tab === "overview" ? (
        <div style={{ display: "grid", gap: 16 }}>
          <StatRow>
            <MetricCard label="Sprints" value={sprints.length} />
            <MetricCard label="Keywords" value={keywords.length} />
            <MetricCard label="Audits" value={audits.length} />
            <MetricCard label="High findings" value={bySeverity.high ?? 0} />
          </StatRow>
          <BarChart title="Audit severity" items={Object.entries(bySeverity).map(([label, value]) => ({ label, value }))} />
        </div>
      ) : null}

      {tab === "sprints" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search sprints…">
            <Button type="button" variant="secondary" onClick={() => setCreate("task")}>Open issue</Button>
            <Button type="button" onClick={() => setCreate("sprint")}>+ Sprint</Button>
          </Toolbar>
          {sprintRows.length === 0 ? (
            <EmptyState title="No sprints yet" description="Open a sprint for one site, then record ranks and tasks." action={<Button type="button" onClick={() => setCreate("sprint")}>+ Sprint</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "name", header: "Sprint" },
                { key: "site_url", header: "Site" },
                {
                  key: "id",
                  header: "",
                  width: "120px",
                  render: (_value, row) => (
                    <Button type="button" variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={() => { setSprintId(String(row.id)); setCreate("task"); }}>
                      Open issue
                    </Button>
                  ),
                },
              ]}
              rows={sprintRows}
              emptyMessage="No sprints match."
            />
          )}
        </div>
      ) : null}

      {tab === "keywords" ? (
        <div style={{ display: "grid", gap: 12 }}>
          <Toolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search keywords…">
            <Button type="button" onClick={() => setCreate("keyword")}>+ Keyword</Button>
          </Toolbar>
          {keywordRows.length === 0 ? (
            <EmptyState title="No keywords yet" description="Record a keyword against a sprint." action={<Button type="button" onClick={() => setCreate("keyword")}>+ Keyword</Button>} />
          ) : (
            <DataTable
              columns={[
                { key: "phrase", header: "Keyword" },
                { key: "rankLabel", header: "Rank", render: (value) => <StatusBadge label={String(value)} status="info" /> },
              ]}
              rows={keywordRows.map((row) => ({ ...row, rankLabel: row.rank == null ? "—" : String(row.rank) }))}
              emptyMessage="No keywords match."
            />
          )}
        </div>
      ) : null}

      <Modal open={create === "sprint"} title="Add sprint" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await createSprint({ name, siteUrl });
            setName("");
            setSiteUrl("");
          }, "Sprint created")}>Save</Button>
        </>
      )}>
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
        <Field label="Site URL"><Input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "keyword"} title="Record keyword" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await recordRank({ sprintId, phrase });
            setPhrase("");
          }, "Rank recorded")}>Save</Button>
        </>
      )}>
        <Field label="Sprint">
          <Select value={sprintId} onChange={(event) => setSprintId(event.target.value)} required>
            <option value="">Sprint</option>
            {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
          </Select>
        </Field>
        <Field label="Keyword"><Input value={phrase} onChange={(event) => setPhrase(event.target.value)} required /></Field>
      </Modal>

      <Modal open={create === "task"} title="Open sprint issue" onClose={() => setCreate(null)} footer={(
        <>
          <Button type="button" variant="secondary" onClick={() => setCreate(null)}>Cancel</Button>
          <Button type="button" onClick={() => void run(async () => {
            await openTask({ sprintId, title: task });
            setTask("");
          }, "Issue opened")}>Open issue</Button>
        </>
      )}>
        <Field label="Sprint">
          <Select value={sprintId} onChange={(event) => setSprintId(event.target.value)} required>
            <option value="">Sprint</option>
            {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}</option>)}
          </Select>
        </Field>
        <Field label="Task title"><Input value={task} onChange={(event) => setTask(event.target.value)} required /></Field>
      </Modal>
    </Page>
  );
}

export function SeoSidebar(_props: PluginSidebarProps) {
  return (
    <SidebarNavLink to="/seo" label="SEO" icon={(
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
    )} />
  );
}

function SidebarNavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref(to);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      {...hostNavigation.linkProps(to)}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <span aria-hidden="true" className="relative shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </a>
  );
}
