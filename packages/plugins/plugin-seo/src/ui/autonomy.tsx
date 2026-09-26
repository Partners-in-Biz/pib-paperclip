/**
 * Setup checklist, Needs you items and the site repo link (0.6.0).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { StatusBadge, type StatusBadgeVariant } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Section, Select, breakAnywhere, fluidColumns, tokens } from "@partnersinbiz/pib-plugin-ui";

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

export type SiteLink = {
  siteAccess: "unlinked" | "repo" | "none";
  siteProjectId: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  framework: string | null;
  hosting: string | null;
  changePolicy: "merge_seo_scope" | "pr_only" | "full";
};

export type ProjectOption = { projectId: string; name: string; urlKey: string | null; repoUrl: string | null; defaultBranch: string | null; suggested: boolean };

type CallFn = (tool: string, params: Record<string, unknown>, success?: string) => Promise<unknown>;

const small: CSSProperties = { height: 28, fontSize: 12, padding: "0 10px" };

const STATUS: Record<SetupItem["status"], { variant: StatusBadgeVariant; label: string }> = {
  done: { variant: "ok", label: "done" },
  todo: { variant: "pending", label: "to do" },
  warn: { variant: "warning", label: "check" },
  unknown: { variant: "info", label: "not checkable" },
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

function Steps({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null;
  return (
    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.55, display: "grid", gap: 2 }}>
      {steps.map((s, i) => (
        <li key={i}>{s.replace(/\*\*/g, "")}</li>
      ))}
    </ol>
  );
}

export function SetupChecklist({ title, items }: { title: string; items: SetupItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  const countable = items.filter((i) => i.status !== "unknown").length;
  return (
    <Section title={title} actions={<span style={{ fontSize: 12, color: tokens.muted }}>{done}/{countable} done</span>}>
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((item) => (
          <div key={item.key} style={{ display: "grid", gap: 6, padding: "8px 0", borderTop: `1px solid ${tokens.border}` }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
              <span style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                <StatusBadge status={STATUS[item.status].variant} label={STATUS[item.status].label} />
                <strong style={{ fontSize: 13 }}>{item.label}</strong>
              </span>
              {item.steps.length > 0 ? (
                <Button type="button" variant="secondary" style={small} onClick={() => setOpen(open === item.key ? null : item.key)}>
                  {open === item.key ? "Hide steps" : "How"}
                </Button>
              ) : null}
            </div>
            <span style={{ fontSize: 12, color: tokens.muted }}>{item.detail}</span>
            {open === item.key ? <Steps steps={item.steps} /> : null}
            <LinkList links={item.links} />
            <span style={{ fontSize: 12 }}>
              <span style={{ color: tokens.muted }}>Then the agent: </span>
              {item.next}
            </span>
          </div>
        ))}
      </div>
    </Section>
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
    <Section
      title="Needs you"
      actions={issueLink ?? null}
    >
      {view.open.length === 0 ? (
        <span style={{ fontSize: 13, color: tokens.muted }}>Nothing needs you. The SEO Specialist runs this sprint on its own.</span>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {view.open.map((item, index) => (
            <div key={item.key} style={{ display: "grid", gap: 6, padding: "8px 0", borderTop: index ? `1px solid ${tokens.border}` : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>
                  {index + 1}. {item.title}
                  {item.optional ? <span style={{ color: tokens.muted, fontWeight: 400 }}> (optional)</span> : null}
                </strong>
                <Button type="button" variant="secondary" style={small} disabled={busy === item.key} onClick={() => void done(item.key)}>
                  {busy === item.key ? "Checking…" : "Done"}
                </Button>
              </div>
              <span style={{ fontSize: 12, color: tokens.muted }}>{item.why}</span>
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
              <span style={{ fontSize: 12 }}>
                <span style={{ color: tokens.muted }}>Then the agent: </span>
                {item.after}
              </span>
            </div>
          ))}
        </div>
      )}
      {view.done.length > 0 ? <span style={{ fontSize: 12, color: tokens.muted }}>Done this week: {view.done.map((d) => d.title).join(" · ")}</span> : null}
    </Section>
  );
}

const POLICY_TEXT: Record<SiteLink["changePolicy"], string> = {
  merge_seo_scope: "Merge SEO-scope changes when checks pass (recommended)",
  pr_only: "Open PRs only; a person merges",
  full: "Merge any SEO change when checks pass",
};

export function SiteRepoSection({ sprintId, site, projects, prefix, call }: { sprintId: string; site: SiteLink; projects: ProjectOption[]; prefix: string | null; call: CallFn }) {
  const [projectId, setProjectId] = useState<string>(site.siteAccess === "none" ? "__none" : site.siteProjectId ?? "");
  const [branch, setBranch] = useState(site.defaultBranch);
  const [hosting, setHosting] = useState(site.hosting ?? "");
  const [policy, setPolicy] = useState<SiteLink["changePolicy"]>(site.changePolicy);
  useEffect(() => {
    setProjectId(site.siteAccess === "none" ? "__none" : site.siteProjectId ?? projects.find((p) => p.suggested)?.projectId ?? "");
    setBranch(site.defaultBranch);
    setHosting(site.hosting ?? "");
    setPolicy(site.changePolicy);
  }, [site.siteAccess, site.siteProjectId, site.defaultBranch, site.hosting, site.changePolicy, projects]);
  const picked = projects.find((p) => p.projectId === projectId) ?? null;
  const save = () =>
    void call(
      "link-site",
      {
        sprintId,
        ...(projectId === "__none" ? { noRepo: true } : projectId ? { projectId } : {}),
        ...(branch.trim() ? { defaultBranch: branch.trim() } : {}),
        ...(hosting ? { hosting } : {}),
        changePolicy: policy,
      },
      projectId === "__none" ? "Saved: no repo access. Change sets go through Needs you." : "Site repo linked. Code tasks open in the site project.",
    );
  const projectsPath = prefix ? `/${prefix}/projects` : "/projects";
  return (
    <Section
      title="Site repo"
      actions={<StatusBadge status={site.siteAccess === "unlinked" ? "pending" : "ok"} label={site.siteAccess === "repo" ? "linked" : site.siteAccess === "none" ? "no repo" : "not linked"} />}
    >
      <span style={{ fontSize: 13, color: tokens.muted }}>
        Code and content tasks open in this project, so the agent works in its repo workspace: branch, PR, checks, preview, merge.
        {site.repoUrl ? <> Repo: <code style={breakAnywhere}>{site.repoUrl}</code>.</> : null}
      </span>
      <div style={{ display: "grid", gridTemplateColumns: fluidColumns(200), gap: 10 }}>
        <Field label="Project with the repo workspace">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Choose a project…</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
                {p.repoUrl ? ` — ${p.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}` : " — no repo URL"}
                {p.suggested ? " (match)" : ""}
              </option>
            ))}
            <option value="__none">No repo access (CMS or client-managed)</option>
          </Select>
        </Field>
        <Field label="Default branch">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={picked?.defaultBranch ?? "main"} />
        </Field>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button type="button" disabled={!projectId} onClick={save}>Save</Button>
        <span style={{ fontSize: 12, color: tokens.muted }}>
          No project for the site yet? <a href={projectsPath} style={{ color: tokens.fg }}>Projects</a> → New project → add a workspace with the repo URL, then pick it here.
        </span>
      </div>
    </Section>
  );
}
