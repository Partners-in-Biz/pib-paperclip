import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, useHostLocation, useHostNavigation, usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useStudioAction } from "./action.js";
import { useMakerLabel } from "./maker.js";
import { ClientCards } from "./ClientCards.js";
import { SaveToDrive } from "./SaveToDrive.js";
import { GiveButton, GivenList } from "./GiveToAgent.js";
import { FromDrive } from "./FromDrive.js";
import { useNarrow } from "./narrow.js";
import { usePreviewUrls } from "./previews.js";

export { StudioCanvasPage } from "./CanvasPage.js";
import { Button, EmptyState, errorText, Field, Input, Page, PageMessage, Section, Select, tone, usePibBaseStyles } from "@partnersinbiz/pib-plugin-ui";
import { formatDuration, humanTitle, metaLine, posterFrameUrl, statusLabel, statusTone } from "./library.js";
import { buildPhotoPresetPrompt, DEFAULT_PRESET_MODEL, DEFAULT_PRESET_RATIO, getPhotoPreset, PHOTO_NOTE_MAX, PHOTO_PRESETS } from "../presets.js";

interface Cap {
  scopeKey: string;
  monthlyCredits: number;
  updatedAt: string | null;
}

interface Model {
  id: string;
  label: string;
  kind: "image" | "video";
  ratios: string[];
  resolutions: string[];
  minRefs?: number;
}

interface Asset {
  id: string;
  name: string;
  kind: string;
  mime: string;
  bytes: number;
  status: string;
  client: { kind: string | null; id: string; name: string | null } | null;
  version?: number;
  createdAt: string | null;
  altText?: string | null;
  /** From the generation that made it; null for imports. */
  prompt?: string | null;
  model?: string | null;
  credits?: number | null;
}

interface Overview {
  period: string;
  companyUsed: number;
  caps: Cap[];
  clientUsage: Array<{ scopeKey: string; used: number }>;
  history: Array<{ scopeKey: string; oldCredits: number | null; newCredits: number | null; changedBy: string; createdAt: string | null }>;
  clients: Array<{ scopeKey: string; name: string }>;
  projects?: Array<{ id: string; name: string }>;
  models?: Model[];
  unavailableModels?: Array<{ id: string; label: string; note: string }>;
}

interface Me {
  role: string;
  canGenerate: boolean;
  isOwner: boolean;
}

interface Detail {
  asset: Asset;
  madeBy: { agentId: string | null; userId: string | null };
  generation: { id: string; model: string; prompt: string; estimatedCredits: number; actualCredits: number | null } | null;
  issue: { id: string; identifier: string | null; title: string | null } | null;
  givenTo?: Array<{ id: string; identifier: string | null; title: string | null; status: string | null; agentName: string | null }>;
}

interface Estimate {
  creditsEach: number;
  creditsTotal: number;
  batchSize: number;
  monthlyCap: number | null;
  remaining: number | null;
}

interface GenerationRow {
  id: string;
  status: string;
  name: string | null;
  assetId: string | null;
  estimatedCredits: number;
  error: string | null;
}

const DEFAULT_SCOPE = "default";
// Mirrors AGENT_RUN_SCOPE and DEFAULT_RUN_LIMIT in ../ledger.ts.
const AGENT_RUN_SCOPE = "agent_run";
const DEFAULT_RUN_LIMIT = 2;
const COMPANY_SCOPE = "company";
const FINISHED = new Set(["succeeded", "failed"]);
const POLL_MS = 4000;

const muted = { fontSize: 13, opacity: 0.7 } as const;
const row = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" } as const;
const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))`, gap: 12 });

function when(at: string | null | undefined): string {
  return at ? at.slice(0, 16).replace("T", " ") : "";
}

type Tab = "library" | "generate" | "usage";

export function StudioPage({ context }: PluginPageProps) {
  usePibBaseStyles();
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? null;
  const overview = usePluginData<Overview>("overview", companyId ? { companyId } : undefined);
  const meAction = useStudioAction("me");
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("library");
  const canvasNav = useHostNavigation();
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [libraryClient, setLibraryClient] = useState<{ value: string; n: number } | null>(null);
  const narrow = useNarrow();

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    meAction({ companyId })
      .then((out) => {
        if (live) setMe(out as Me);
      })
      .catch((err) => {
        if (live) setMeError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [companyId]);

  const description = "Creative assets, generation and monthly credit caps.";
  if (!companyId) return <Page title="Studio" description="Pick a company first.">{null}</Page>;
  if (overview.error) return <Page title="Studio" description={description} message={errorText(overview.error)} messageTone="danger">{null}</Page>;
  const data = overview.data;
  if (!data) return <Page title="Studio" description={description}>Loading…</Page>;

  const tabs: Array<[Tab, string]> = [
    ["library", "Library"],
    ["generate", "Generate"],
    ["usage", "Usage and caps"],
  ];

  return (
    <Page title="Studio" description={`Credits used in ${data.period}: ${data.companyUsed}`} actions={<a {...canvasNav.linkProps("/studio-canvas")}>Open canvas</a>}>
      {meError ? <PageMessage tone="danger" message={meError} /> : null}
      {narrow ? (
        // Phone: a bottom tab bar (spec PAR-8040 item 7); Boards opens the canvas.
        <nav aria-label="Studio" style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 40, display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", background: "var(--background)", borderTop: "1px solid var(--border)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {(["library", "boards", "generate", "usage"] as const).map((key) => {
            const label = key === "library" ? "Library" : key === "boards" ? "Boards" : key === "generate" ? "Generate" : "Usage";
            const style = { minHeight: 48, display: "grid", placeItems: "center", fontSize: 13, color: tab === key ? "var(--foreground)" : "var(--muted-foreground)", fontWeight: tab === key ? 600 : 400, textDecoration: "none", background: "transparent", border: 0, font: "inherit" } as const;
            return key === "boards" ? (
              <a key={key} {...canvasNav.linkProps("/studio-canvas")} style={style}>
                {label}
              </a>
            ) : (
              <button key={key} type="button" aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)} style={style}>
                {label}
              </button>
            );
          })}
        </nav>
      ) : (
        <div role="tablist" aria-label="Studio" style={{ ...row, marginBottom: 12 }}>
          {tabs.map(([key, label]) => (
            <Button key={key} role="tab" aria-selected={tab === key} variant={tab === key ? "primary" : "secondary"} onClick={() => setTab(key)}>
              {label}
            </Button>
          ))}
        </div>
      )}
      {tab === "library" ? <Library companyId={companyId} data={data} version={libraryVersion} presetClient={libraryClient} canReview={me?.canGenerate === true} /> : null}
      {tab === "library" ? (
        <ClientCards
          companyId={companyId}
          version={libraryVersion}
          onOpenLibrary={(value) => {
            setLibraryClient((prev) => ({ value, n: (prev?.n ?? 0) + 1 }));
            // The cards sit below the library grid; bring the filtered grid into view.
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      ) : null}
      {tab === "generate" ? (
        <Generate
          companyId={companyId}
          data={data}
          me={me}
          onStored={() => {
            setLibraryVersion((v) => v + 1);
            overview.refresh();
          }}
        />
      ) : null}
      {tab === "usage" ? <Usage companyId={companyId} data={data} me={me} refresh={overview.refresh} /> : null}
      {narrow ? <div aria-hidden="true" style={{ height: 64 }} /> : null}
    </Page>
  );
}


function Preview({ kind, name, url, height = 160 }: { kind: string; name: string; url: string | undefined; height?: number }) {
  const box = { width: "100%", height, objectFit: "cover" as const, borderRadius: 8, background: "rgba(127,127,127,0.12)", display: "block" };
  if (!url) return <div style={{ ...box, display: "grid", placeItems: "center", ...muted }}>{kind}</div>;
  if (kind === "video") return <video src={url} style={box} muted playsInline controls preload="metadata" />;
  return <img src={url} alt={name} style={box} loading="lazy" />;
}

export { useNarrow };

const cardBox = { borderRadius: "var(--radius-lg, 10px)", border: "1px solid var(--border)", overflow: "hidden", minWidth: 0 } as const;
/** Text on media: a dark scrim keeps pills readable (AA) on any picture. */
const scrim = "color-mix(in srgb, var(--background, black) 72%, transparent)";

/** A segmented row of filter chips; a count shows after the label when given. */
function ChipGroup({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string, number?]> }) {
  return (
    // One row that scrolls sideways on a phone rather than wrapping inside the pill.
    <div role="group" aria-label={label} style={{ display: "inline-flex", flexWrap: "nowrap", overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "none", gap: 2, padding: 2, border: "1px solid var(--border)", borderRadius: 999, maxWidth: "100%" }}>
      {options.map(([v, text, n]) => (
        <button
          key={v || "all"}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          style={{ border: 0, borderRadius: 999, padding: "4px 12px", minHeight: 32, font: "inherit", fontSize: 13, cursor: "pointer", color: value === v ? "var(--foreground)" : "var(--muted-foreground)", background: value === v ? "var(--accent, var(--muted))" : "transparent", fontWeight: value === v ? 600 : 400 }}
        >
          {text}
          {typeof n === "number" ? <span style={{ marginLeft: 6, opacity: 0.7 }}>{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Library card: 4:3 media first, status pill on it, a human title and one meta line. Videos show their first frame. */
function LibraryCard({ asset, url, meta, onOpen }: { asset: Asset; url: string | undefined; meta: string; onOpen: () => void }) {
  const [duration, setDuration] = useState<number | null>(null);
  const t = tone(statusTone(asset.status));
  const media = { width: "100%", height: "100%", objectFit: "cover" as const, display: "block" };
  const isVideo = asset.kind === "video";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${humanTitle(asset.prompt, asset.name)}`}
      title={asset.prompt ?? asset.name}
      style={{ ...cardBox, textAlign: "left", background: "var(--card)", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", display: "flex", flexDirection: "column" }}
    >
      <div style={{ position: "relative", aspectRatio: "4 / 3", background: "var(--muted)", width: "100%" }}>
        {!url ? null : isVideo ? (
          <video src={posterFrameUrl(url)} style={media} muted playsInline preload="metadata" aria-label={asset.name} onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} />
        ) : (
          <img src={url} alt={asset.altText ?? asset.name} style={media} loading="lazy" />
        )}
        <span style={{ position: "absolute", top: 8, left: 8, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: `color-mix(in srgb, ${t.solid} 30%, ${scrim})`, border: `1px solid ${t.border}`, color: "var(--foreground)" }}>{statusLabel(asset.status)}</span>
        {isVideo ? (
          <span aria-hidden="true" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 36, height: 36, borderRadius: 999, display: "grid", placeItems: "center", background: scrim, color: "var(--foreground)", fontSize: 14 }}>
            ▶
          </span>
        ) : null}
        {isVideo && duration ? <span style={{ position: "absolute", right: 8, bottom: 8, padding: "1px 6px", borderRadius: 6, fontSize: 12, background: scrim, color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(duration)}</span> : null}
      </div>
      <div style={{ padding: "8px 10px 10px", minWidth: 0, width: "100%", boxSizing: "border-box" }}>
        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{humanTitle(asset.prompt, asset.name)}</div>
        <div style={{ ...muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}</div>
      </div>
    </button>
  );
}

function Library({ companyId, data, version, presetClient, canReview }: { companyId: string; data: Overview; version: number; presetClient: { value: string; n: number } | null; canReview: boolean }) {
  const [client, setClient] = useState(presetClient?.value ?? "");
  useEffect(() => {
    if (presetClient) setClient(presetClient.value);
  }, [presetClient]);
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  // The canvas links here with ?asset=<id> to open one file.
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("asset")));
  const [reviewed, setReviewed] = useState(0);
  const params = useMemo(() => ({ companyId, client, projectId, kind, status, sort, limit: 60, v: `${version}.${reviewed}` }), [companyId, client, projectId, kind, status, sort, version, reviewed]);
  const assets = usePluginData<{ assets: Asset[]; counts?: Record<string, number> }>("assets", params);
  const list = assets.data?.assets ?? [];
  const counts = assets.data?.counts ?? {};
  const previews = usePreviewUrls(companyId, list.map((a) => a.id));
  const open = list.find((a) => a.id === openId);
  const narrow = useNarrow();
  const labels = useMemo(() => new Map([...(data.models ?? []), ...(data.unavailableModels ?? [])].map((m) => [m.id, m.label])), [data]);
  const modelLabel = (id: string) => labels.get(id) ?? id;

  return (
    <>
      <Section title="Library">
        <div style={{ ...row, marginBottom: 10 }}>
          <ChipGroup
            label="Status"
            value={status}
            onChange={setStatus}
            options={[["", "All", counts.all], ["draft", "Draft", counts.draft], ["approved", "Approved", counts.approved], ["rejected", "Rejected", counts.rejected]]}
          />
          <ChipGroup label="Kind" value={kind} onChange={setKind} options={[["", "All kinds"], ["image", "Images"], ["video", "Videos"]]} />
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value === "oldest" ? "oldest" : "newest")} style={{ width: "auto" }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </div>
        {/* Phone: client and project fold away so the grid starts near the top (spec PAR-8040 item 7). */}
        <details open={!narrow || client !== "" || projectId !== ""} style={{ marginBottom: 12 }}>
          <summary style={{ ...muted, cursor: "pointer", marginBottom: 8, display: narrow ? undefined : "none" }}>More filters</summary>
        <div style={grid(160)}>
          <Field label="Client">
            <Select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All</option>
              <option value="own">Own work</option>
              {data.clients.map((c) => (
                <option key={c.scopeKey} value={c.scopeKey}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project">
            <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All</option>
              {(data.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        </details>
        {canReview ? (
          <div style={{ marginBottom: 12 }}>
            <FromDrive
              companyId={companyId}
              client={client}
              onImported={(added) => {
                setReviewed((n) => n + 1);
                // One file opens; several stay in the grid, newest first.
                if (added.length === 1) setOpenId(added[0]!.id);
              }}
            />
          </div>
        ) : null}
        {assets.error ? <PageMessage tone="danger" message={errorText(assets.error)} /> : null}
        {previews.error ? <PageMessage tone="warning" message={`${previews.error} Trying again shortly.`} /> : null}
        {assets.data && list.length === 0 ? <EmptyState compact title="No assets match these filters" description="Clear a filter, or generate something new." /> : null}
        <div style={narrow ? { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 } : grid(220)}>
          {!assets.data && !assets.error ? Array.from({ length: 8 }, (_, i) => <div key={i} aria-hidden="true" style={{ ...cardBox, aspectRatio: "4 / 3", background: "var(--muted)" }} />) : null}
          {list.map((a) => (
            <LibraryCard key={a.id} asset={a} url={previews.urls[a.id]} meta={metaLine(a, modelLabel, narrow)} onOpen={() => setOpenId(a.id)} />
          ))}
        </div>
      </Section>
      {openId ? <AssetDetail companyId={companyId} assetId={openId} kind={open?.kind ?? "image"} previewUrl={previews.urls[openId]} canReview={canReview} close={() => setOpenId(null)} onReviewed={() => setReviewed((n) => n + 1)} /> : null}
    </>
  );
}

function AssetDetail({
  companyId,
  assetId,
  kind,
  previewUrl,
  canReview,
  close,
  onReviewed,
}: {
  companyId: string;
  assetId: string;
  kind: string;
  previewUrl: string | undefined;
  /** Viewers can't review (the worker refuses them too), so they don't get the buttons. */
  canReview: boolean;
  close: () => void;
  onReviewed: () => void;
}) {
  const [v, setV] = useState(0);
  const detailParams = useMemo(() => ({ companyId, assetId, v }), [companyId, assetId, v]);
  const detail = usePluginData<Detail>("asset", detailParams);
  const maker = useMakerLabel(companyId, detail.data?.madeBy);
  const assetUrl = useStudioAction("asset-url");
  const reviewAction = useStudioAction("review");
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function review(decision: "approved" | "rejected") {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      const out = (await reviewAction({ companyId, assetId, decision })) as { changed: boolean; exported: boolean };
      setNotice(out.exported ? "Approved. It's on its way to Social's media library for this client." : out.changed ? "Rejected." : `Already ${decision}.`);
      setV((n) => n + 1);
      onReviewed();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  // A side panel fixed in the viewport: below the grid it opened out of sight, so a click looked like it did nothing.
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    ref.current?.focus?.();
  }, [assetId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function download() {
    setMessage(null);
    try {
      const out = (await assetUrl({ companyId, assetId })) as { url: string };
      window.open(out.url, "_blank", "noopener");
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  const d = detail.data;
  const term = { margin: 0, overflowWrap: "anywhere" as const };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={d?.asset.name ?? "Asset"}
      tabIndex={-1}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 100vw)",
        overflowY: "auto",
        zIndex: 50,
        background: "var(--background, #fff)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "0 0 24px rgba(0, 0, 0, 0.25)",
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      <Section
        title={d?.asset.name ?? "Asset"}
        actions={
          <div style={row}>
            {canReview && d && (d.asset.status === "draft" || d.asset.status === "rejected") ? (
              <Button disabled={busy} onClick={() => void review("approved")}>
                Approve
              </Button>
            ) : null}
            {canReview && d && d.asset.status === "draft" ? (
              <Button variant="secondary" disabled={busy} onClick={() => void review("rejected")}>
                Reject
              </Button>
            ) : null}
            <Button onClick={() => void download()}>Download</Button>
            {canReview && d ? (
              <SaveToDrive companyId={companyId} assetId={assetId} bytes={d.asset.bytes} savedUrl={(d as { drive?: { url: string }[] }).drive?.[0]?.url ?? null} />
            ) : null}
            {/* Viewers can't give (the worker refuses them too). */}
            {canReview && d ? <GiveButton companyId={companyId} assetId={assetId} assetName={d.asset.name} onGiven={() => setV((n) => n + 1)} /> : null}
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          </div>
        }
      >
        {message ? <PageMessage tone="danger" message={message} /> : null}
        {notice ? <PageMessage tone="success" message={notice} /> : null}
        {detail.error ? <PageMessage tone="danger" message={errorText(detail.error)} /> : null}
        {!d && !detail.error ? <div style={muted}>Loading…</div> : null}
        {d ? (
          <div style={grid(280)}>
            <Preview kind={kind} name={d.asset.name} url={previewUrl} height={320} />
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(80px, max-content) minmax(0, 1fr)", gap: "6px 12px", fontSize: 14, alignContent: "start" }}>
              <dt style={muted}>Prompt</dt>
              <dd style={{ ...term, whiteSpace: "pre-wrap" }}>{d.generation?.prompt ?? "Not generated (imported)"}</dd>
              <dt style={muted}>Model</dt>
              <dd style={term}>{d.generation?.model ?? "—"}</dd>
              <dt style={muted}>Cost</dt>
              <dd style={term}>{d.generation ? `${d.generation.actualCredits ?? d.generation.estimatedCredits} credits` : "—"}</dd>
              <dt style={muted}>Made by</dt>
              <dd style={term}>{maker}</dd>
              <dt style={muted}>Issue</dt>
              <dd style={term}>{d.issue ? `${d.issue.identifier ?? d.issue.id}${d.issue.title ? `: ${d.issue.title}` : ""}` : "—"}</dd>
              <dt style={muted}>Client</dt>
              <dd style={term}>{d.asset.client?.name ?? "Own work"}</dd>
              <dt style={muted}>Given to</dt>
              <dd style={term}><GivenList items={d.givenTo ?? []} /></dd>
              <dt style={muted}>Status</dt>
              <dd style={term}>{d.asset.status}</dd>
              <dt style={muted}>File</dt>
              <dd style={term}>
                {d.asset.mime} · {Math.max(1, Math.round(d.asset.bytes / 1024))} KB · v{d.asset.version ?? 1}
              </dd>
              <dt style={muted}>Created</dt>
              <dd style={term}>{when(d.asset.createdAt)}</dd>
            </dl>
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function Generate({ companyId, data, me, onStored }: { companyId: string; data: Overview; me: Me | null; onStored: () => void }) {
  // Models that need a reference image wait for the canvas (slice 2b): the page has no picker for one yet.
  const models = (data.models ?? []).filter((m) => !m.minRefs);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState("");
  const preset = getPhotoPreset(presetId);
  const [ratio, setRatio] = useState(model?.ratios[0] ?? "");
  const [resolution, setResolution] = useState(model?.resolutions[0] ?? "");
  const [batchSize, setBatchSize] = useState("1");
  const [client, setClient] = useState("own");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const estimateAction = useStudioAction("estimate");
  const generateAction = useStudioAction("generate");

  useEffect(() => {
    if (!model) return;
    if (!model.ratios.includes(ratio)) setRatio(model.ratios[0] ?? "");
    if (!model.resolutions.includes(resolution)) setResolution(model.resolutions[0] ?? "");
  }, [model?.id]);
  // Any change to the request makes the shown price stale.
  useEffect(() => setEstimate(null), [modelId, prompt, presetId, ratio, resolution, batchSize, client]);

  function pickPreset(id: string) {
    setPresetId(id);
    const next = getPhotoPreset(id);
    if (!next) return;
    const soul = models.find((m) => m.id === DEFAULT_PRESET_MODEL);
    if (soul) setModelId(soul.id);
    if ((soul ?? model)?.ratios.includes(DEFAULT_PRESET_RATIO)) setRatio(DEFAULT_PRESET_RATIO);
    setPrompt((p) => p.slice(0, PHOTO_NOTE_MAX));
  }

  const request = () => ({ companyId, model: model?.id, prompt, preset: presetId || undefined, ratio, resolution, batchSize: Number(batchSize), client });

  async function runEstimate() {
    setBusy(true);
    setMessage(null);
    try {
      setEstimate((await estimateAction(request())) as Estimate);
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function runGenerate() {
    setBusy(true);
    setMessage(null);
    try {
      const out = (await generateAction(request())) as { groupId?: string };
      if (out.groupId) setGroups((g) => [out.groupId as string, ...g].slice(0, 10));
      setMessage({ text: "Queued. It shows below as it runs and lands in the library when it's done.", tone: "success" });
      setEstimate(null);
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const viewer = me !== null && !me.canGenerate;
  const ready = !!model && (preset !== null || prompt.trim().length > 0) && !busy && !viewer;

  return (
    <>
      <Section title="Generate">
        {viewer ? <PageMessage tone="warning" message="Viewers can look at Studio but can't generate. Ask a company owner for member access." /> : null}
        {models.length === 0 ? <PageMessage tone="warning" message="No fixed-price models are offered yet." /> : null}
        <div style={grid(160)}>
          <Field label="Style">
            <Select aria-label="Style" value={presetId} onChange={(e) => pickPreset(e.target.value)}>
              <option value="">No style (free prompt)</option>
              {PHOTO_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.tagline}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <Select aria-label="Model" value={model?.id ?? ""} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {(data.unavailableModels ?? []).map((m) => (
                <option key={`na-${m.id}`} value={`na-${m.id}`} disabled>
                  {m.label} · {m.note}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ratio">
            <Select aria-label="Ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {(model?.ratios ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Resolution">
            <Select aria-label="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)}>
              {(model?.resolutions ?? []).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Batch size">
            <Select aria-label="Batch size" value={batchSize} onChange={(e) => setBatchSize(e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For">
            <Select aria-label="For client" value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="own">Own work</option>
              {data.clients.map((c) => (
                <option key={c.scopeKey} value={c.scopeKey}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label={preset ? "Extra direction (optional)" : "Prompt"}>
            <textarea
              aria-label="Prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              maxLength={preset ? PHOTO_NOTE_MAX : 4000}
              placeholder={preset ? `Optional note, up to ${PHOTO_NOTE_MAX} characters` : "Describe the image"}
              style={{ width: "100%", boxSizing: "border-box", font: "inherit", padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", resize: "vertical" }}
            />
          </Field>
        </div>
        {preset ? <p style={{ ...muted, margin: "8px 0 0" }}>{preset.label} builds the prompt for you. Best with {preset.subject === "any" ? "anything" : `a ${preset.subject}`}.</p> : null}
        {message ? <PageMessage tone={message.tone} message={message.text} /> : null}
        {estimate ? (
          <div style={{ ...row, margin: "10px 0" }} aria-live="polite">
            <strong>
              {estimate.creditsTotal} credits ({estimate.batchSize} × {estimate.creditsEach})
            </strong>
            <span style={muted}>{estimate.monthlyCap === null ? "No cap is set, so generation is off." : `${estimate.remaining} of ${estimate.monthlyCap} left this month.`}</span>
          </div>
        ) : null}
        <div style={{ ...row, marginTop: 10 }}>
          <Button variant="secondary" disabled={!ready} onClick={() => void runEstimate()}>
            Estimate
          </Button>
          <Button disabled={!ready || !estimate} onClick={() => void runGenerate()}>
            {busy ? "Working…" : estimate ? `Generate for ${estimate.creditsTotal} credits` : "Generate"}
          </Button>
          {!estimate ? <span style={muted}>Estimate first: it shows the cost before anything is charged.</span> : null}
        </div>
      </Section>
      {groups.length > 0 ? <Progress companyId={companyId} groups={groups} onStored={onStored} /> : null}
    </>
  );
}

/** Polls this page's own batches until each has finished, and shows the results as they land. */
function Progress({ companyId, groups, onStored }: { companyId: string; groups: string[]; onStored: () => void }) {
  const gens = usePluginData<{ generations: GenerationRow[] }>("generations", { companyId, groupIds: groups });
  const rows = gens.data?.generations ?? [];
  const pending = rows.length === 0 || rows.some((g) => !FINISHED.has(g.status));
  const stored = rows.filter((g) => g.assetId).map((g) => g.assetId as string);
  const storedKey = stored.join(",");
  const previews = usePreviewUrls(companyId, stored);
  const refresh = gens.refresh;

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);
  const seen = useRef("");
  useEffect(() => {
    if (storedKey && storedKey !== seen.current) {
      seen.current = storedKey;
      onStored();
    }
  }, [storedKey]);

  return (
    <Section title="Generations from this page">
      {gens.error ? <PageMessage tone="danger" message={errorText(gens.error)} /> : null}
      {rows.length === 0 && !gens.error ? <div style={muted}>Waiting for the queue…</div> : null}
      <div style={grid(180)}>
        {rows.map((g) => (
          <div key={g.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 8, minWidth: 0 }}>
            {g.assetId ? (
              <Preview kind="image" name={g.name ?? "Result"} url={previews.urls[g.assetId]} />
            ) : (
              <div style={{ height: 160, display: "grid", placeItems: "center", ...muted }}>{g.status === "failed" ? "Failed" : "Working…"}</div>
            )}
            <div style={{ fontWeight: 600, marginTop: 6, overflowWrap: "anywhere" }}>{g.name ?? "Generation"}</div>
            <div style={{ ...muted, overflowWrap: "anywhere" }}>
              {g.status} · {g.estimatedCredits} credits
              {g.error ? ` · ${g.error}` : ""}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function CapRow({ label, hint, scopeKey, cap, used, save, busy, editable }: { label: string; hint: string; scopeKey: string; cap: Cap | undefined; used?: number; save: (scopeKey: string, value: string) => void; busy: boolean; editable: boolean }) {
  const [value, setValue] = useState(cap ? String(cap.monthlyCredits) : "");
  useEffect(() => setValue(cap ? String(cap.monthlyCredits) : ""), [cap?.monthlyCredits]);
  const changed = value.trim() !== (cap ? String(cap.monthlyCredits) : "");
  return (
    <div style={{ ...row, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={muted}>
          {hint}
          {used !== undefined ? ` ${used}${cap ? ` of ${cap.monthlyCredits}` : ""} used this month.` : ""}
        </div>
      </div>
      {editable ? (
        <>
          <div style={{ width: 120 }}>
            <Input aria-label={`${label} monthly credits`} type="number" min={0} step="any" placeholder="Not set" value={value} onChange={(event) => setValue(event.target.value)} />
          </div>
          <Button disabled={busy || !changed} onClick={() => save(scopeKey, value)}>
            Save
          </Button>
        </>
      ) : (
        <div style={{ fontWeight: 600 }}>{cap ? `${cap.monthlyCredits} credits` : "Not set"}</div>
      )}
    </div>
  );
}

function Usage({ companyId, data, me, refresh }: { companyId: string; data: Overview; me: Me | null; refresh: () => void }) {
  const setCap = useStudioAction("set-cap");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [addClient, setAddClient] = useState("");
  const owner = me?.isOwner === true;

  const capOf = (key: string) => data.caps.find((c) => c.scopeKey === key);
  const nameOf = (key: string) => (key === DEFAULT_SCOPE ? "Default" : key === COMPANY_SCOPE ? "Company" : key === AGENT_RUN_SCOPE ? "Per agent run" : (data.clients.find((c) => c.scopeKey === key)?.name ?? key));
  const clientCaps = data.caps.filter((c) => c.scopeKey.includes(":"));
  const addable = data.clients.filter((c) => !capOf(c.scopeKey));
  const anyCap = data.caps.some((c) => c.scopeKey === COMPANY_SCOPE || c.scopeKey === DEFAULT_SCOPE);

  async function save(scopeKey: string, value: string) {
    setBusy(true);
    setMessage(null);
    try {
      await setCap({ companyId, scopeKey, monthlyCredits: value.trim() === "" ? null : Number(value) });
      refresh();
      setMessage({ text: `${nameOf(scopeKey)} cap saved. It applies to the next generation.`, tone: "success" });
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message ? <PageMessage tone={message.tone} message={message.text} /> : null}
      {!anyCap ? <PageMessage tone="warning" message="No cap is set, so generation is off. A company owner sets a company cap to turn it on." /> : null}
      <Section title="Monthly credit caps">
        <CapRow label="Company" hint="All of this company's work, clients included." scopeKey={COMPANY_SCOPE} cap={capOf(COMPANY_SCOPE)} used={data.companyUsed} save={save} busy={busy} editable={owner} />
        <CapRow label="Default" hint="Used when the company cap is blank." scopeKey={DEFAULT_SCOPE} cap={capOf(DEFAULT_SCOPE)} save={save} busy={busy} editable={owner} />
        {clientCaps.map((c) => (
          <CapRow key={c.scopeKey} label={nameOf(c.scopeKey)} hint="Replaces the company cap for this client's work." scopeKey={c.scopeKey} cap={c} used={data.clientUsage.find((u) => u.scopeKey === c.scopeKey)?.used ?? 0} save={save} busy={busy} editable={owner} />
        ))}
        {owner && addable.length > 0 ? (
          <div style={{ ...row, paddingTop: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <Select aria-label="Client" value={addClient} onChange={(event) => setAddClient(event.target.value)}>
                <option value="">Add a cap for a client…</option>
                {addable.map((c) => (
                  <option key={c.scopeKey} value={c.scopeKey}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              disabled={busy || !addClient}
              onClick={() => {
                const scopeKey = addClient;
                setAddClient("");
                void save(scopeKey, String(capOf(COMPANY_SCOPE)?.monthlyCredits ?? capOf(DEFAULT_SCOPE)?.monthlyCredits ?? 0));
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
        <p style={{ ...muted, marginTop: 12 }}>{owner ? "Leave a cap blank to clear it. 0 turns generation off." : "Only a company owner can change a cap."}</p>
        <CapRow
          label="Per agent run"
          hint={`The most one agent run may spend. Above it the agent stops and asks a person. Blank uses the default of ${DEFAULT_RUN_LIMIT} credits; 0 stops agents generating. People on this page are not limited by it.`}
          scopeKey={AGENT_RUN_SCOPE}
          cap={capOf(AGENT_RUN_SCOPE)}
          save={save}
          busy={busy}
          editable={owner}
        />
      </Section>
      <Section title="Cap changes">
        {data.history.length === 0 ? <div style={muted}>No changes yet.</div> : null}
        {data.history.map((h, i) => (
          <div key={`${h.scopeKey}-${h.createdAt}-${i}`} style={{ fontSize: 13, padding: "4px 0", overflowWrap: "anywhere" }}>
            {when(h.createdAt)} · {nameOf(h.scopeKey)}: {h.oldCredits ?? "not set"} to {h.newCredits ?? "not set"} · {h.changedBy}
          </div>
        ))}
      </Section>
    </>
  );
}

export function StudioSidebar(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === navigation.resolveHref("/studio");
  return (
    <a
      {...navigation.linkProps("/studio")}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      ].join(" ")}
      style={{ textDecoration: "none" }}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
      <span className="flex-1 truncate">Studio</span>
    </a>
  );
}
