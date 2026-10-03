/**
 * Setup checklist, Needs you items and the site link (0.6.0): a repo project,
 * a client's WordPress site through the PiB Connector (0.10.0), or none.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, InlineText, Input, ListChecks, Pill, UserRound, ProgressBar, Section, SectionCard, Select, breakAnywhere, fluidColumns, tokens, type ToneName } from "@partnersinbiz/pib-plugin-ui";
import { shownBranch as branchShown, siteLinkParams, WORDPRESS_PREFIX } from "./site-link.js";

export type UiLink = { label: string; url: string };

export type SetupItem = {
  key: string;
  label: string;
  status: "done" | "todo" | "warn" | "unknown";
  detail: string;
  steps: string[];
  links: UiLink[];
  next: string;
};

export type NeedsYouItem = {
  key: string;
  kind: string;
  title: string;
  why: string;
  steps: string[];
  links: UiLink[];
  after: string;
  copy: string | null;
  optional: boolean;
  status: "open" | "done";
  check: string;
  doneAt: string | null;
};

export type NeedsYouView = { weekStart: string; issueId: string | null; issueIdentifier: string | null; open: NeedsYouItem[]; done: NeedsYouItem[] };

/** A client's WordPress site from the CRM, as the site link shows it. */
export type WordPressSite = {
  siteId: string;
  url: string;
  label: string | null;
  connectorStatus: string;
  connected: boolean;
  /** "WordPress · Yoast SEO · Connector connected" */
  summary: string;
  suggested?: boolean;
};

export type SiteLink = {
  siteAccess: "unlinked" | "repo" | "none" | "wordpress";
  siteProjectId: string | null;
  siteId?: string | null;
  site?: WordPressSite | null;
  repoUrl: string | null;
  defaultBranch: string;
  framework: string | null;
  hosting: string | null;
  changePolicy: "merge_seo_scope" | "pr_only" | "full";
};

export type ProjectOption = { projectId: string; name: string; urlKey: string | null; repoUrl: string | null; defaultBranch: string | null; suggested: boolean };

type CallFn = (tool: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;

const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };

const STATUS: Record<SetupItem["status"], { tone: ToneName; label: string }> = {
  done: { tone: "ok", label: "done" },
  todo: { tone: "warn", label: "to do" },
  warn: { tone: "bad", label: "check" },
  unknown: { tone: "neutral", label: "not checkable" },
};

function LinkList({ links }: { links: UiLink[] }) {
  if (links.length === 0) return null;
  return (
    <span style={{ display: "flex", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
      {links.map((l) => (
        <a key={l.url} href={l.url} target={/^https?:\/\//.test(l.url) ? "_blank" : undefined} rel="noreferrer" style={{ color: tokens.fg, fontWeight: 500, minHeight: 24, display: "inline-flex", alignItems: "center", ...breakAnywhere }}>
          {l.label} ↗
        </a>
      ))}
    </span>
  );
}

/** Steps with their **bold**, `code` and [links](/path) rendered (never the raw markdown). */
function Steps({ steps }: { steps: string[] }) {
  const nav = useHostNavigation();
  if (steps.length === 0) return null;
  return (
    <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.55, display: "grid", gap: 3, listStyle: "decimal" }}>
      {steps.map((s, i) => (
        <li key={i}><InlineText text={s} linkFor={(href) => ({ ...nav.linkProps(href) })} /></li>
      ))}
    </ol>
  );
}

function Rich({ text }: { text: string }) {
  const nav = useHostNavigation();
  return <InlineText text={text} linkFor={(href) => ({ ...nav.linkProps(href) })} />;
}

export function SetupChecklist({ title, items, note }: { title: string; items: SetupItem[]; note?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  const countable = items.filter((i) => i.status !== "unknown").length;
  return (
    <SectionCard title={title} icon={ListChecks} subtitle={done === countable ? "Everything is set up" : `${countable - done} ${countable - done === 1 ? "step" : "steps"} left`} tone={done === countable ? "ok" : undefined} actions={<Pill tone={done === countable ? "ok" : "warn"}>{done} of {countable} done</Pill>}>
      <ProgressBar done={done} total={countable} size="sm" ariaLabel={`${done} of ${countable} setup steps done`} />
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((item) => (
          <div key={item.key} style={{ display: "grid", gap: 6, padding: "8px 0", borderTop: `1px solid ${tokens.border}` }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                <Pill tone={STATUS[item.status].tone} dot>{STATUS[item.status].label}</Pill>
                <strong style={{ fontSize: 13 }}>{item.label}</strong>
              </span>
              {item.steps.length > 0 ? (
                <Button type="button" variant="secondary" style={small} onClick={() => setOpen(open === item.key ? null : item.key)}>
                  {open === item.key ? "Hide steps" : "How"}
                </Button>
              ) : null}
            </div>
            <span style={{ fontSize: 12.5, color: tokens.muted }}><Rich text={item.detail} /></span>
            {open === item.key ? <Steps steps={item.steps} /> : null}
            <LinkList links={item.links} />
            <span style={{ fontSize: 12.5 }}>
              <span style={{ color: tokens.muted }}>Then the agent: </span>
              <Rich text={item.next} />
            </span>
          </div>
        ))}
      </div>
      {note ? <span style={{ fontSize: 12.5, color: tokens.muted }}>{note}</span> : null}
    </SectionCard>
  );
}

export function NeedsYouSection({ sprintId, view, call, issueLink }: { sprintId: string; view: NeedsYouView | null; call: CallFn; issueLink?: ReactNode }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!view) return null;
  const done = async (key: string) => {
    setBusy(key);
    try {
      await call("needs-you-resolve", { sprintId, key }, "Marked done. The agent re-checks and carries on.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <SectionCard
      title={`Needs you${view.open.length ? ` (${view.open.length})` : ""}`}
      subtitle="What only a person can do for this sprint, batched in one issue a week"
      icon={UserRound}
      tone={view.open.length ? "warn" : "ok"}
      strip={view.open.length > 0}
      actions={issueLink ?? null}
    >
      {view.open.length === 0 ? (
        <span style={{ fontSize: 13, color: tokens.muted }}>Nothing needs you. The SEO agent runs this sprint on its own.</span>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {view.open.map((item, index) => (
            <div key={item.key} style={{ display: "grid", gap: 6, padding: "8px 0", borderTop: index ? `1px solid ${tokens.border}` : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13, display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Pill size="sm" tone={item.optional ? "neutral" : "warn"}>{index + 1}</Pill>{item.title}
                  {item.optional ? <span style={{ color: tokens.muted, fontWeight: 400 }}> (optional)</span> : null}
                </strong>
                <Button type="button" variant="secondary" style={small} disabled={busy === item.key} onClick={() => void done(item.key)}>
                  {busy === item.key ? "Checking…" : "Done"}
                </Button>
              </div>
              <span style={{ fontSize: 12.5, color: tokens.muted }}><Rich text={item.why} /></span>
              <Steps steps={item.steps} />
              <LinkList links={item.links} />
              {item.copy ? (
                <div style={{ display: "grid", gap: 4 }}>
                  <textarea readOnly value={item.copy} rows={Math.min(12, item.copy.split("\n").length + 1)} style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", width: "100%", borderRadius: 8, border: `1px solid ${tokens.border}`, padding: 8, background: tokens.secondary, color: tokens.fg }} />
                  <span>
                    <Button type="button" variant="secondary" style={small} onClick={() => void navigator.clipboard?.writeText(item.copy ?? "")}>Copy text</Button>
                  </span>
                </div>
              ) : null}
              <span style={{ fontSize: 12.5 }}>
                <span style={{ color: tokens.muted }}>Then the agent: </span>
                <Rich text={item.after} />
              </span>
            </div>
          ))}
        </div>
      )}
      {view.done.length > 0 ? <span style={{ fontSize: 12, color: tokens.muted }}>Done this week: {view.done.map((d) => d.title).join(" · ")}</span> : null}
    </SectionCard>
  );
}

const POLICY_TEXT: Record<SiteLink["changePolicy"], string> = {
  merge_seo_scope: "Merge SEO-scope changes when checks pass (recommended)",
  pr_only: "Open PRs only; a person merges",
  full: "Merge any SEO change when checks pass",
};

const WP = WORDPRESS_PREFIX;

function currentChoice(site: SiteLink): string {
  if (site.siteAccess === "none") return "__none";
  if (site.siteAccess === "wordpress" && site.siteId) return `${WP}${site.siteId}`;
  return site.siteProjectId ?? "";
}

function siteHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function SiteRepoSection({ sprintId, site, projects, wordpressSites = [], prefix, call }: { sprintId: string; site: SiteLink; projects: ProjectOption[]; wordpressSites?: WordPressSite[]; prefix: string | null; call: CallFn }) {
  const [projectId, setProjectId] = useState<string>(currentChoice(site));
  const [branch, setBranch] = useState(site.defaultBranch);
  // Only a branch typed here is sent: otherwise the server takes the project's work branch (its workspace policy), not the old value shown.
  const [branchEdited, setBranchEdited] = useState(false);
  const [hosting, setHosting] = useState(site.hosting ?? "");
  const [policy, setPolicy] = useState<SiteLink["changePolicy"]>(site.changePolicy);
  // A stable key: callers may pass a fresh [] each render.
  const wpKey = wordpressSites.map((w) => `${w.siteId}:${w.connectorStatus}`).join(",");
  useEffect(() => {
    const suggestedWp = wordpressSites.find((w) => w.suggested && w.connected);
    setProjectId(currentChoice(site) || (suggestedWp ? `${WP}${suggestedWp.siteId}` : projects.find((p) => p.suggested)?.projectId ?? ""));
    setBranch(site.defaultBranch);
    setBranchEdited(false);
    setHosting(site.hosting ?? "");
    setPolicy(site.changePolicy);
  }, [site.siteAccess, site.siteProjectId, site.siteId, site.defaultBranch, site.hosting, site.changePolicy, projects, wpKey]);
  const wordpressId = projectId.startsWith(WP) ? projectId.slice(WP.length) : null;
  const pickedWp = wordpressId ? wordpressSites.find((w) => w.siteId === wordpressId) ?? (site.site?.siteId === wordpressId ? site.site : null) : null;
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  // A newly picked project shows the branch the server will use for it (its work branch) until one is typed.
  const shownBranch = branchShown({ branchEdited, choice: projectId, currentChoice: currentChoice(site), branch, pickedBranch: picked?.defaultBranch ?? null });
  const save = () =>
    void call(
      "link-site",
      siteLinkParams({ sprintId, choice: projectId, branch, branchEdited, hosting, changePolicy: policy }),
      projectId === "__none"
        ? "Saved: no repo access. Change sets go through Needs you."
        : wordpressId
          ? "WordPress site linked. The agent changes it through the PiB Connector."
          : "Site repo linked. Code tasks open in the site project.",
    );
  const current = site.siteAccess === "wordpress" ? site.site ?? null : null;
  const projectsPath = prefix ? `/${prefix}/projects` : "/projects";
  return (
    <Section
      title="Site repo"
      actions={
        <Pill dot tone={site.siteAccess === "unlinked" ? "warn" : site.siteAccess === "repo" || (site.siteAccess === "wordpress" && current?.connected) ? "ok" : site.siteAccess === "wordpress" ? "warn" : "neutral"}>
          {site.siteAccess === "repo" ? "linked" : site.siteAccess === "wordpress" ? "WordPress" : site.siteAccess === "none" ? "no repo" : "not linked"}
        </Pill>
      }
    >
      {site.siteAccess === "wordpress" ? (
        <span style={{ fontSize: 13, color: tokens.muted, display: "grid", gap: 4 }}>
          <span>
            The agent changes this WordPress site through the PiB Connector: SEO fields, schema, redirects, robots, sitemap, image alt text, featured images and page copy, each checked on the live site.
            {current ? <> Site: <code style={breakAnywhere}>{siteHost(current.url)}</code> · {current.summary}.</> : " The linked site is no longer in the CRM: pick it again."}
          </span>
          {current && !current.connected ? <span style={{ color: tokens.destructive }}>The Connector is not connected yet. Connect it on the CRM client page → Websites.</span> : null}
        </span>
      ) : (
        <span style={{ fontSize: 13, color: tokens.muted }}>
          Code and content tasks open in this project, so the agent works in its repo workspace: branch, PR, checks, preview, merge.
          {site.repoUrl ? <> Repo: <code style={breakAnywhere}>{site.repoUrl}</code>.</> : null}
        </span>
      )}
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(200), gap: 10 }}>
        <Field label={wordpressSites.length > 0 ? "Repo project or WordPress site" : "Project with the repo workspace"}>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose a project…</option>
            <optgroup label="Repo projects">
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                  {p.repoUrl ? ` — ${p.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}` : " — no repo URL"}
                  {p.suggested ? " (match)" : ""}
                </option>
              ))}
            </optgroup>
            {wordpressSites.length > 0 ? (
              <optgroup label="WordPress (PiB Connector)">
                {wordpressSites.map((w) => (
                  <option key={w.siteId} value={`${WP}${w.siteId}`}>
                    {w.label ? `${w.label} — ` : ""}{siteHost(w.url)} — {w.summary}{w.suggested ? " (match)" : ""}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value="__none">No repo access (CMS or client-managed)</option>
          </Select>
        </Field>
        {wordpressId ? null : (
          <Field label="Default branch">
            <Input value={shownBranch} onChange={(e) => { setBranch(e.target.value); setBranchEdited(true); }} placeholder={picked?.defaultBranch ?? "main"} />
          </Field>
        )}
        <Field label="Hosting">
          <Select value={hosting} onChange={(e) => setHosting(e.target.value)}>
            <option value="">Unknown</option>
            <option value="vercel">Vercel</option>
            <option value="netlify">Netlify</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Change policy">
          <Select value={policy} onChange={(e) => setPolicy(e.target.value as SiteLink["changePolicy"])}>
            {(Object.keys(POLICY_TEXT) as Array<SiteLink["changePolicy"]>).map((k) => (
              <option key={k} value={k}>{POLICY_TEXT[k]}</option>
            ))}
          </Select>
        </Field>
      </div>
      {picked && !picked.repoUrl ? <span style={{ fontSize: 12, color: tokens.destructive }}>This project has no repo URL on its workspace. Add one in the project first.</span> : null}
      {pickedWp && !pickedWp.connected && site.siteAccess !== "wordpress" ? (
        <span style={{ fontSize: 12, color: tokens.destructive }}>The PiB Connector is not connected on this site yet. Connect it on the CRM client page → Websites; until then the agent cannot change the site.</span>
      ) : null}
      {site.siteAccess === "wordpress" && site.changePolicy === "pr_only" ? (
        <div style={{ display: "grid", gap: 6, padding: 10, border: `1px solid ${tokens.border}`, borderRadius: 8 }}>
          <span style={{ fontSize: 12, color: tokens.muted }}>
            This site needs the client's sign-off. The agent cannot change it, whatever it is told: it proposes changes with a preview link for the client. After the client approves, press this to let the agent apply the approved changes for 24 hours.
          </span>
          <div>
            <Button type="button" variant="secondary" onClick={() => void call("approve-site-writes", { sprintId }, "Approved. The agent applies the client-approved changes for the next 24 hours.")}>Apply approved changes</Button>
          </div>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button type="button" disabled={!projectId} onClick={save}>Save</Button>
        <span style={{ fontSize: 12, color: tokens.muted }}>
          No project for the site yet? <a href={projectsPath} style={{ color: tokens.fg }}>Projects</a> → New project → add a workspace with the repo URL, then pick it here. A client's WordPress site is added on the CRM client page → Websites.
        </span>
      </div>
    </Section>
  );
}
