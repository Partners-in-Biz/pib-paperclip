/**
 * Client workspace cards: the client's websites (several per client, with
 * the PiB Connector for WordPress) and the client's Paperclip projects.
 */
import { useState, type FormEvent } from "react";
import {
  Blocks,
  Button,
  CircleAlert,
  EmptyState,
  Field,
  Form,
  Input,
  KeyRound,
  Modal,
  Pill,
  Plug,
  RefreshCw,
  SectionCard,
  Select,
  Server,
  TextArea,
  tokens,
} from "@partnersinbiz/pib-plugin-ui";
import {
  CONNECTOR_STATUS_LABELS,
  SITE_ACCESS_KINDS,
  SITE_PLATFORM_LABELS,
  SITE_PLATFORMS,
  SITE_SEO_PLUGIN_LABELS,
  SITE_SEO_PLUGINS,
  type ConnectorStatus,
  type SiteAccessKind,
  type SitePlatform,
  type SiteSeoPlugin,
} from "@partnersinbiz/pib-plugin-kit/client-sites";

export interface SiteView {
  id: string;
  label: string | null;
  url: string;
  platform: SitePlatform;
  seoPlugin: SiteSeoPlugin | null;
  hosting: string | null;
  access: SiteAccessKind[];
  projectId: string | null;
  projectLink: string | null;
  webRoot: string | null;
  notes: string | null;
  summary: string;
  connector: { status: ConnectorStatus; keyId: string | null; version: string | null; seenAt: string | null; error: string | null };
  health: Record<string, unknown> | null;
}

export interface ProjectView {
  projectId: string;
  name: string;
  status: string | null;
  repoUrl: string | null;
  archived: boolean;
  link: string | null;
  suggested?: boolean;
}

export interface ConnectResult {
  key: string;
  keyId: string;
  download: string | null;
  steps: string[];
  note: string;
}

type LinkProps = { href?: string; onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void };

const muted = { margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45 } as const;
const smallButton = { height: 28, fontSize: 12 } as const;

const ACCESS_LABELS: Record<SiteAccessKind, string> = {
  repo: "Repo (code in the project's workspace)",
  connector: "PiB Connector (WordPress)",
  sftp: "SFTP (login set as env on the project)",
};

function statusTone(status: ConnectorStatus): "ok" | "warn" | "bad" | "neutral" {
  return status === "connected" ? "ok" : status === "error" ? "bad" : status === "pending" ? "warn" : "neutral";
}

function ago(value: string | null): string | null {
  if (!value) return null;
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

interface Draft {
  url: string;
  label: string;
  platform: SitePlatform;
  seoPlugin: SiteSeoPlugin | "";
  hosting: string;
  access: SiteAccessKind[];
  projectId: string;
  webRoot: string;
  notes: string;
}

function draftOf(site: SiteView | null): Draft {
  return {
    url: site?.url ?? "",
    label: site?.label ?? "",
    platform: site?.platform ?? "wordpress",
    seoPlugin: site?.seoPlugin ?? "",
    hosting: site?.hosting ?? "",
    access: site?.access ?? [],
    projectId: site?.projectId ?? "",
    webRoot: site?.webRoot ?? "",
    notes: site?.notes ?? "",
  };
}

/**
 * The client's websites. A WordPress site is connected once (a person pastes
 * a key into the PiB Connector plugin); after that agents make SEO changes
 * through it and every module shows its status.
 */
export function WebsitesCard({
  sites,
  projects,
  download,
  onSave,
  onDelete,
  onConnect,
  onCheck,
  projectLinkProps,
}: {
  sites: SiteView[];
  projects: ProjectView[];
  download: string | null;
  onSave: (patch: Record<string, unknown>, success: string) => Promise<boolean>;
  onDelete: (siteId: string) => Promise<boolean>;
  onConnect: (siteId: string) => Promise<ConnectResult | null>;
  onCheck: (siteId: string) => Promise<boolean>;
  projectLinkProps: (path: string) => LinkProps;
}) {
  const [editing, setEditing] = useState<SiteView | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState<{ site: SiteView; result: ConnectResult } | null>(null);
  const [removing, setRemoving] = useState<SiteView | null>(null);

  function open(site: SiteView | "new") {
    setDraft(draftOf(site === "new" ? null : site));
    setEditing(site);
  }

  function toggleAccess(kind: SiteAccessKind) {
    setDraft((d) => ({ ...d, access: d.access.includes(kind) ? d.access.filter((k) => k !== kind) : SITE_ACCESS_KINDS.filter((k) => k === kind || d.access.includes(k)) }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    const patch: Record<string, unknown> = {
      url: draft.url,
      label: draft.label,
      platform: draft.platform,
      seoPlugin: draft.platform === "wordpress" ? draft.seoPlugin || null : null,
      hosting: draft.hosting,
      access: draft.access,
      projectId: draft.projectId || null,
      webRoot: draft.webRoot,
      notes: draft.notes,
    };
    if (editing !== "new") patch.siteId = editing.id;
    const ok = await onSave(patch, editing === "new" ? "Website added" : "Website saved");
    setSaving(false);
    if (ok) setEditing(null);
  }

  async function connect(site: SiteView) {
    setBusy(site.id);
    const result = await onConnect(site.id);
    setBusy(null);
    if (result) setConnected({ site, result });
  }

  async function check(site: SiteView) {
    setBusy(site.id);
    await onCheck(site.id);
    setBusy(null);
  }

  const wordpress = draft.platform === "wordpress";

  return (
    <SectionCard
      title={`Websites (${sites.length})`}
      icon={Server}
      subtitle="Every site of this client: what it runs on and how agents reach it. SEO sprints pick one of these."
      actions={<Button type="button" variant="secondary" style={smallButton} onClick={() => open("new")}>+ Add website</Button>}
    >
      {sites.length === 0 ? (
        <EmptyState
          compact
          icon={Server}
          title="No websites yet"
          description="Add each site the client has. For WordPress, connect the PiB Connector once so agents can make SEO changes themselves."
          action={<Button type="button" onClick={() => open("new")}>Add a website</Button>}
        />
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
          {sites.map((site) => {
            const seen = ago(site.connector.seenAt);
            const blogPublic = site.health?.blogPublic;
            return (
              <li key={site.id} style={{ display: "grid", gap: 6, padding: 12, borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
                  <a href={site.url} target="_blank" rel="noreferrer" style={{ color: tokens.primary, fontWeight: 600, fontSize: 13.5, overflowWrap: "anywhere" }}>
                    {site.url.replace(/^https?:\/\//, "")} ↗
                  </a>
                  {site.label ? <Pill size="sm">{site.label}</Pill> : null}
                  <Pill size="sm" tone="info">{SITE_PLATFORM_LABELS[site.platform]}</Pill>
                  {site.platform === "wordpress" && site.seoPlugin ? <Pill size="sm">{SITE_SEO_PLUGIN_LABELS[site.seoPlugin]}</Pill> : null}
                  {site.platform === "wordpress" ? (
                    <Pill size="sm" tone={statusTone(site.connector.status)} dot title={site.connector.error ?? undefined}>
                      Connector: {CONNECTOR_STATUS_LABELS[site.connector.status].toLowerCase()}
                    </Pill>
                  ) : null}
                </div>
                <p style={muted}>
                  {[
                    site.hosting ? `Hosted on ${site.hosting}` : null,
                    site.access.length ? `Access: ${site.access.join(", ")}` : "No agent access yet",
                    site.connector.version ? `Connector ${site.connector.version}` : null,
                    seen ? `checked ${seen}` : null,
                    site.connector.keyId ? `key id ${site.connector.keyId}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                {site.projectLink ? (
                  <p style={muted}>
                    Project: <a {...projectLinkProps(site.projectLink)} style={{ color: tokens.primary }}>{projects.find((p) => p.projectId === site.projectId)?.name ?? "open project"}</a>
                  </p>
                ) : null}
                {site.connector.error && site.connector.status !== "connected" ? (
                  <p style={{ ...muted, color: tokens.tones.bad.fg, display: "flex", gap: 6 }}>
                    <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
                    {site.connector.error}
                  </p>
                ) : null}
                {blogPublic === false ? <p style={{ ...muted, color: tokens.tones.bad.fg }}>Search engines are switched off on this site (Settings → Reading).</p> : null}
                {site.notes ? <p style={{ ...muted, whiteSpace: "pre-wrap" }}>{site.notes}</p> : null}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {site.platform === "wordpress" ? (
                    <Button type="button" variant={site.connector.status === "none" ? "primary" : "secondary"} style={smallButton} disabled={busy === site.id} onClick={() => void connect(site)}>
                      <Plug size={13} aria-hidden="true" /> {site.connector.status === "none" ? "Connect WordPress" : "New key"}
                    </Button>
                  ) : null}
                  {site.connector.keyId ? (
                    <Button type="button" variant="secondary" style={smallButton} disabled={busy === site.id} onClick={() => void check(site)}>
                      <RefreshCw size={13} aria-hidden="true" /> {busy === site.id ? "Checking…" : "Check"}
                    </Button>
                  ) : null}
                  <Button type="button" variant="secondary" style={smallButton} onClick={() => open(site)}>Edit</Button>
                  <Button type="button" variant="secondary" style={smallButton} onClick={() => setRemoving(site)}>Remove</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {download ? (
        <p style={{ ...muted, marginTop: 10 }}>
          WordPress plugin: <a href={download} download style={{ color: tokens.primary, fontWeight: 600 }}>pib-connector.zip</a> (install once per site).
        </p>
      ) : null}

      <Modal
        open={editing !== null}
        title={editing === "new" ? "Add a website" : "Edit website"}
        onClose={() => {
          if (!saving) setEditing(null);
        }}
      >
        <Form onSubmit={(event) => void submit(event)}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 12 }}>
            <Field label="Address">
              <Input value={draft.url} inputMode="url" required onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://www.acme.co.za" />
            </Field>
            <Field label="Label (when there are several)">
              <Input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Main site, shop, auctions" />
            </Field>
            <Field label="Built on">
              <Select value={draft.platform} onChange={(event) => setDraft({ ...draft, platform: event.target.value as SitePlatform })}>
                {SITE_PLATFORMS.map((p) => <option key={p} value={p}>{SITE_PLATFORM_LABELS[p]}</option>)}
              </Select>
            </Field>
            {wordpress ? (
              <Field label="SEO plugin">
                <Select value={draft.seoPlugin} onChange={(event) => setDraft({ ...draft, seoPlugin: event.target.value as SiteSeoPlugin | "" })}>
                  <option value="">Not sure (the Connector detects it)</option>
                  {SITE_SEO_PLUGINS.map((p) => <option key={p} value={p}>{SITE_SEO_PLUGIN_LABELS[p]}</option>)}
                </Select>
              </Field>
            ) : null}
            <Field label="Hosting">
              <Input value={draft.hosting} onChange={(event) => setDraft({ ...draft, hosting: event.target.value })} placeholder="xneelo, Vercel, Afrihost" />
            </Field>
            <Field label="Project (code and deploys)">
              <Select value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
                <option value="">None</option>
                {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="How agents reach it">
            <div style={{ display: "grid", gap: 6 }}>
              {SITE_ACCESS_KINDS.filter((kind) => kind !== "connector" || wordpress).map((kind) => (
                <label key={kind} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input type="checkbox" checked={draft.access.includes(kind)} onChange={() => toggleAccess(kind)} />
                  {ACCESS_LABELS[kind]}
                </label>
              ))}
            </div>
          </Field>
          {draft.access.includes("sftp") ? (
            <Field label="WordPress folder on the SFTP login">
              <Input value={draft.webRoot} onChange={(event) => setDraft({ ...draft, webRoot: event.target.value })} placeholder="public_html" />
            </Field>
          ) : null}
          {draft.access.includes("sftp") || draft.access.includes("repo") ? (
            <p style={muted}>
              {draft.access.includes("sftp")
                ? "SFTP: add the login as company secrets and bind them on the project (Project → Settings → Env): WP_SFTP_HOST, WP_SFTP_PORT, WP_SFTP_USER and WP_SFTP_PASSWORD (or WP_SFTP_KEY). Only runs in that project get them."
                : "Repo: the project's workspace holds the site's code."}
              {" "}Only projects linked to this client are listed (Projects card).
            </p>
          ) : null}
          <Field label="Notes for agents">
            <TextArea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Staging URL, cache plugin to purge, 'deactivate plugins, never delete'…" />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || !draft.url.trim()}>{saving ? "Saving…" : "Save website"}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={connected !== null} title={`Connect ${connected?.site.url.replace(/^https?:\/\//, "") ?? "WordPress"}`} onClose={() => setConnected(null)}>
        {connected ? (
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Connector key (shown only now)">
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Input readOnly value={connected.result.key} onFocus={(event) => event.currentTarget.select()} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
                <Button type="button" variant="secondary" style={smallButton} onClick={() => void navigator.clipboard?.writeText(connected.result.key)}>
                  <KeyRound size={13} aria-hidden="true" /> Copy
                </Button>
              </div>
            </Field>
            <p style={muted}>Key id {connected.result.keyId}: the WordPress settings page shows the same id once the key is saved there.</p>
            <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6, fontSize: 13, lineHeight: 1.45 }}>
              {connected.result.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {connected.result.download ? (
              <a href={connected.result.download} download style={{ color: tokens.primary, fontWeight: 600, fontSize: 13 }}>Download pib-connector.zip</a>
            ) : (
              <p style={muted}>The download link appears after the CRM page has been opened once.</p>
            )}
            <p style={muted}>{connected.result.note}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button type="button" variant="secondary" onClick={() => setConnected(null)}>Close</Button>
              <Button type="button" onClick={() => {
                const site = connected.site;
                setConnected(null);
                void check(site);
              }}>
                I pasted it: check now
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={removing !== null}
        title={`Remove ${removing?.url.replace(/^https?:\/\//, "") ?? "website"}?`}
        description="Agents stop using it and SEO sprints linked to it lose their WordPress link. The Connector plugin stays on the site until someone deactivates it in wp-admin."
        onClose={() => setRemoving(null)}
        footer={(
          <>
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button type="button" onClick={() => {
              const site = removing;
              if (!site) return;
              void onDelete(site.id).then((ok) => {
                if (ok) setRemoving(null);
              });
            }}>
              Remove website
            </Button>
          </>
        )}
      >
        <p style={muted}>This only removes it from Paperclip.</p>
      </Modal>
    </SectionCard>
  );
}

/** The client's Paperclip projects (code folders), with a picker for unlinked ones. */
export function ProjectsCard({
  projects,
  options,
  onLink,
  onUnlink,
  projectLinkProps,
}: {
  projects: ProjectView[];
  options: ProjectView[];
  onLink: (projectId: string) => Promise<boolean>;
  onUnlink: (projectId: string) => Promise<boolean>;
  projectLinkProps: (path: string) => LinkProps;
}) {
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const suggested = options.filter((option) => option.suggested);

  return (
    <SectionCard
      title={`Projects (${projects.length})`}
      icon={Blocks}
      subtitle="This client's Paperclip projects: their code and the work done in it."
      actions={options.length > 0 ? <Button type="button" variant="secondary" style={smallButton} onClick={() => {
        setPick(suggested[0]?.projectId ?? options[0]?.projectId ?? "");
        setPicking(true);
      }}>+ Link project</Button> : undefined}
    >
      {projects.length === 0 ? (
        <p style={muted}>
          No projects linked yet.{suggested.length > 0 ? ` ${suggested.map((s) => s.name).join(", ")} look${suggested.length === 1 ? "s" : ""} like this client's.` : ""}
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {projects.map((project) => (
            <li key={project.projectId} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", borderRadius: 10, border: `1px solid ${tokens.border}`, minWidth: 0 }}>
              {project.link ? (
                <a {...projectLinkProps(project.link)} style={{ color: tokens.primary, fontWeight: 600, fontSize: 13.5 }}>{project.name}</a>
              ) : (
                <span style={{ fontSize: 13.5, color: tokens.muted }}>{project.name}</span>
              )}
              {project.status ? <Pill size="sm">{project.status.replace(/_/g, " ")}</Pill> : null}
              {project.repoUrl ? <span style={{ fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" }}>{project.repoUrl.replace(/^https?:\/\/(www\.)?/, "")}</span> : null}
              <Button type="button" variant="secondary" style={{ ...smallButton, marginLeft: "auto" }} onClick={() => void onUnlink(project.projectId)}>Unlink</Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={picking} title="Link a project to this client" onClose={() => {
        if (!busy) setPicking(false);
      }}>
        <Form onSubmit={(event) => {
          event.preventDefault();
          if (!pick) return;
          setBusy(true);
          void onLink(pick).then((ok) => {
            setBusy(false);
            if (ok) setPicking(false);
          });
        }}>
          <Field label="Project">
            <Select value={pick} onChange={(event) => setPick(event.target.value)}>
              {options.map((option) => <option key={option.projectId} value={option.projectId}>{option.suggested ? `${option.name} (suggested)` : option.name}</option>)}
            </Select>
          </Field>
          <p style={muted}>A project belongs to one client. Projects already linked to another client are not listed.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button type="button" variant="secondary" onClick={() => setPicking(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !pick}>{busy ? "Linking…" : "Link project"}</Button>
          </div>
        </Form>
      </Modal>
    </SectionCard>
  );
}
