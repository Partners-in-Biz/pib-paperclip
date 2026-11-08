import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, useHostLocation, useHostNavigation, usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useStudioAction } from "./action.js";
import { useMakerLabel } from "./maker.js";
import { BrandKitBox } from "./BrandKit.js";
import { ChipGroup } from "./ChipGroup.js";
import { TemplateGallery } from "./TemplateGallery.js";
import { fieldLabel, fillPrompt, missingFields, placeholdersOf, type PromptTemplate } from "../prompt-templates.js";
import { ClientCards } from "./ClientCards.js";
import { SaveToDrive } from "./SaveToDrive.js";
import { GiveButton, GivenList } from "./GiveToAgent.js";
import { FromDrive } from "./FromDrive.js";
import { useNarrow } from "./narrow.js";
import { usePreviewUrls } from "./previews.js";

export { StudioCanvasPage } from "./CanvasPage.js";
export { StudioEditorPage } from "./editor/EditorPage.js";
import { BarList, Blocks, Building2, Button, ButtonLink, CircleCheck, Coins, EmptyState, errorText, Field, Gauge, Hourglass, Input, MetricCard, MetricRow, Package, Page, PageMessage, ProgressBar, Section, Select, Sparkles, Tabs, tone, useGroupedNav, usePibBaseStyles } from "@partnersinbiz/pib-plugin-ui";
import { formatDuration, humanTitle, metaLine, posterFrameUrl, statusLabel, statusTone } from "./library.js";
import { disabledNote, durationChips } from "../canvas-settings.js";
import { buildPhotoPresetPrompt, DEFAULT_PRESET_MODEL, DEFAULT_PRESET_RATIO, getPhotoPreset, PHOTO_NOTE_MAX } from "../presets.js";

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
  durations?: number[];
  defaultDuration?: number | null;
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
  agents?: Array<{ id: string; name: string; title: string | null }>;
  projects?: Array<{ id: string; name: string }>;
  models?: Model[];
  unavailableModels?: Array<{ id: string; label: string; note: string }>;
}

interface Me {
  role: string;
  canGenerate: boolean;
  isOwner: boolean;
  canSetAgentLimit?: boolean;
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
// Mirrors agentLimitKey in ../ledger.ts: one agent's per-run limit lives under agent:<agentId>.
const AGENT_LIMIT_PREFIX = "agent:";
const FINISHED = new Set(["succeeded", "failed"]);
const POLL_MS = 4000;

const muted = { fontSize: 13, color: "var(--muted-foreground)" } as const;
const row = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" } as const;
const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))`, gap: 12 });

function when(at: string | null | undefined): string {
  return at ? at.slice(0, 16).replace("T", " ") : "";
}

type Tab = "library" | "generate" | "usage";
const TAB_ICONS = { library: Blocks, generate: Sparkles, usage: Gauge } as const;

const roundCredits = (n: number) => Math.round(n * 100) / 100;

/** The company cap, or the default when the company cap is blank. */
const effectiveCap = (data: Overview) => data.caps.find((c) => c.scopeKey === COMPANY_SCOPE) ?? data.caps.find((c) => c.scopeKey === DEFAULT_SCOPE) ?? null;

/** The credits number on the Library: what is left of the cap that applies, or what was used when no cap is set. */
function CreditsMetric({ data }: { data: Overview }) {
  const cap = effectiveCap(data);
  const used = roundCredits(data.companyUsed);
  if (!cap) return <MetricCard icon={Coins} value={used} label="Credits used this month" description="No cap set, so generation is off" tone="warn" />;
  const left = Math.max(0, roundCredits(cap.monthlyCredits - data.companyUsed));
  const low = left <= cap.monthlyCredits * 0.1;
  return <MetricCard icon={Coins} value={left} label="Credits left this month" description={`${used} used of ${cap.monthlyCredits}`} tone={left === 0 ? "bad" : low ? "warn" : undefined} />;
}

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
  if (!companyId) return <Page accent="studio" title="Studio" description="Pick a company first.">{null}</Page>;
  if (overview.error) return <Page accent="studio" title="Studio" description={description} message={errorText(overview.error)} messageTone="danger">{null}</Page>;
  const data = overview.data;
  if (!data) return <Page accent="studio" title="Studio" description={description}>Loading…</Page>;

  const tabs: Array<[Tab, string]> = [
    ["library", "Library"],
    ["generate", "Generate"],
    ["usage", "Usage and caps"],
  ];

  return (
    <Page accent="studio" title="Studio" description={`Images and video from your team and agents. Credits used in ${data.period}: ${roundCredits(data.companyUsed)}.`} actions={<ButtonLink {...canvasNav.linkProps("/studio-canvas")}>Open canvas</ButtonLink>}>
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
        <Tabs tabs={tabs.map(([id, label]) => ({ id, label, icon: TAB_ICONS[id] }))} active={tab} onChange={(id) => setTab(id as Tab)} />
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

const cardBox = { borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden", minWidth: 0 } as const;
/** Text on media: a dark scrim keeps pills readable (AA) on any picture. */
const scrim = "color-mix(in srgb, var(--background, black) 72%, transparent)";

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
      className="pib-link-card"
      style={{ ...cardBox, textAlign: "left", background: "color-mix(in oklab, var(--background) 70%, transparent)", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", display: "flex", flexDirection: "column" }}
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
        <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{humanTitle(asset.prompt, asset.name)}</div>
        <div style={{ ...muted, fontSize: 12, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}</div>
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
  const clientSelect = (
    <Select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)} style={{ width: narrow ? undefined : "auto" }}>
      <option value="">All clients</option>
      <option value="own">Own work</option>
      {data.clients.map((c) => (
        <option key={c.scopeKey} value={c.scopeKey}>
          {c.name}
        </option>
      ))}
    </Select>
  );
  const projectSelect = (
    <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: narrow ? undefined : "auto" }}>
      <option value="">All projects</option>
      {(data.projects ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <MetricRow>
        <MetricCard icon={Package} value={counts.all ?? "–"} label="Files" description={client || projectId ? "With these filters" : "Images and video"} />
        <MetricCard icon={Hourglass} value={counts.draft ?? "–"} label="Waiting for review" description="Drafts nobody has approved yet" />
        <MetricCard icon={CircleCheck} value={counts.approved ?? "–"} label="Approved" description="Ready to use" />
        <CreditsMetric data={data} />
      </MetricRow>
      <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
        <div style={row}>
          <ChipGroup
            label="Status"
            value={status}
            onChange={setStatus}
            options={[["", "All", counts.all], ["draft", "Draft", counts.draft], ["approved", "Approved", counts.approved], ["rejected", "Rejected", counts.rejected]]}
          />
          <ChipGroup label="Kind" value={kind} onChange={setKind} options={[["", "All kinds"], ["image", "Images"], ["video", "Videos"]]} />
          {narrow ? null : clientSelect}
          {narrow ? null : projectSelect}
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value === "oldest" ? "oldest" : "newest")} style={{ width: "auto", marginLeft: narrow ? undefined : "auto" }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </div>
        {/* Phone: client and project fold away so the grid starts near the top (spec PAR-8040 item 7). */}
        {narrow ? (
          <details open={client !== "" || projectId !== ""}>
            <summary style={{ ...muted, cursor: "pointer", marginBottom: 8 }}>More filters</summary>
            <div style={grid(160)}>
              {clientSelect}
              {projectSelect}
            </div>
          </details>
        ) : null}
        {canReview ? (
          <div>
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
      </div>
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
  const saveTemplateAction = useStudioAction("save-prompt-template");
  const createEditAction = useStudioAction("video-edit-create");
  const editNav = useHostNavigation();
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
  async function saveAsTemplate(from: Detail) {
    setBusy(true);
    setMessage(null);
    setNotice(null);
    try {
      await saveTemplateAction({
        companyId,
        title: humanTitle(from.generation?.prompt, from.asset.name).slice(0, 80),
        tagline: "Saved from the library",
        prompt: from.generation?.prompt,
        kind: from.asset.kind,
        model: from.generation?.model,
        assetId: from.asset.id,
      });
      setNotice("Saved. It's under Your templates on the Generate tab, with this file as its picture.");
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

  async function editVideo() {
    setMessage(null);
    setBusy(true);
    try {
      const out = (await createEditAction({ companyId, assetIds: [assetId] })) as { id?: string };
      if (!out?.id) throw new Error("The video edit could not be created. Try again.");
      editNav.navigate(`/studio-editor?edit=${encodeURIComponent(out.id)}`);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

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
            {canReview && kind === "video" ? (
              <Button variant="secondary" disabled={busy} onClick={() => void editVideo()}>
                Edit video
              </Button>
            ) : null}
            {canReview && d ? (
              <SaveToDrive companyId={companyId} assetId={assetId} bytes={d.asset.bytes} savedUrl={(d as { drive?: { url: string }[] }).drive?.[0]?.url ?? null} />
            ) : null}
            {canReview && d?.generation?.prompt ? (
              <Button variant="secondary" disabled={busy} onClick={() => void saveAsTemplate(d)}>
                Save as template
              </Button>
            ) : null}
            {/* Viewers can't give (the worker refuses them too). */}
            {canReview && d ? (
              <GiveButton
                companyId={companyId}
                assetId={assetId}
                onGiven={(out) => {
                  setMessage(out.warning);
                  setNotice(out.message);
                  setV((n) => n + 1);
                }}
                onError={(err) => {
                  setNotice(null);
                  setMessage(err);
                }}
              />
            ) : null}
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
  const narrow = useNarrow();
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  const [presetId, setPresetId] = useState("");
  const preset = getPhotoPreset(presetId);
  const [ratio, setRatio] = useState(model?.ratios[0] ?? "");
  const [resolution, setResolution] = useState(model?.resolutions[0] ?? "");
  const [duration, setDuration] = useState(String(model?.defaultDuration ?? ""));
  const [batchSize, setBatchSize] = useState("1");
  const [client, setClient] = useState("own");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const [saved, setSaved] = useState<PromptTemplate[]>([]);
  const [savedProblem, setSavedProblem] = useState<string | null>(null);
  const [template, setTemplate] = useState<PromptTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [naming, setNaming] = useState<string | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const estimateAction = useStudioAction("estimate");
  const generateAction = useStudioAction("generate");
  const listTemplates = useStudioAction("prompt-templates");
  const saveTemplateAction = useStudioAction("save-prompt-template");
  const deleteTemplateAction = useStudioAction("delete-prompt-template");

  useEffect(() => {
    let live = true;
    listTemplates({ companyId })
      .then((out) => live && setSaved((out as { saved: PromptTemplate[] }).saved))
      .catch((err) => live && setSavedProblem(errorText(err)));
    return () => {
      live = false;
    };
    // `listTemplates` is a new function each render; the list depends only on the company.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    if (!model) return;
    if (!model.ratios.includes(ratio)) setRatio(model.ratios[0] ?? "");
    if (!model.resolutions.includes(resolution)) setResolution(model.resolutions[0] ?? "");
    if (!(model.durations ?? []).includes(Number(duration))) setDuration(String(model.defaultDuration ?? ""));
  }, [model?.id]);
  const finalPrompt = preset ? prompt : fillPrompt(prompt, fields);
  const blanks = preset ? [] : missingFields(prompt, fields);
  const fieldNames = preset ? [] : placeholdersOf(prompt);
  // Any change to the request makes the shown price stale.
  useEffect(() => setEstimate(null), [modelId, finalPrompt, presetId, ratio, resolution, duration, batchSize, client]);

  /** Bring the composer into view when picking wrapped it out of sight (a phone or a narrow window). */
  const showComposer = () => composerRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });

  function pickPreset(id: string) {
    setTemplate(null);
    setFields({});
    setNaming(null);
    setPresetId(id);
    const next = getPhotoPreset(id);
    if (next) {
      const soul = models.find((m) => m.id === DEFAULT_PRESET_MODEL);
      if (soul) setModelId(soul.id);
      if ((soul ?? model)?.ratios.includes(DEFAULT_PRESET_RATIO)) setRatio(DEFAULT_PRESET_RATIO);
      setPrompt("");
    }
    showComposer();
  }

  function pickTemplate(next: PromptTemplate) {
    setPresetId("");
    setNaming(null);
    setMessage(null);
    setTemplate(next);
    setFields({});
    setPrompt(next.prompt);
    const chosen = models.find((m) => m.id === next.model) ?? (model?.kind === next.kind ? model : models.find((m) => m.kind === next.kind));
    if (chosen) {
      setModelId(chosen.id);
      if (next.ratio && chosen.ratios.includes(next.ratio)) setRatio(next.ratio);
      if (next.resolution && chosen.resolutions.includes(next.resolution)) setResolution(next.resolution);
    } else {
      setMessage({ text: `No ${next.kind} model is on offer right now, so this template can't run yet.`, tone: "danger" });
    }
    showComposer();
  }

  function startBlank() {
    setTemplate(null);
    setPresetId("");
    setFields({});
    setNaming(null);
    setPrompt("");
    setMessage(null);
  }

  async function saveAsTemplate() {
    setBusy(true);
    setMessage(null);
    try {
      const out = (await saveTemplateAction({ companyId, title: naming ?? "", prompt, kind: model?.kind, ratio, model: model?.id, resolution })) as { template: PromptTemplate };
      setSaved((list) => [out.template, ...list]);
      setTemplate(out.template);
      setNaming(null);
      setMessage({ text: "Saved. Everyone in this company can use it now.", tone: "success" });
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate(target: PromptTemplate) {
    if (!window.confirm(`Delete the template "${target.title}"? This removes it for everyone in the company. Files it already made stay in the library.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteTemplateAction({ companyId, id: target.id });
      setSaved((list) => list.filter((t) => t.id !== target.id));
      setTemplate(null);
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const request = () => ({ companyId, model: model?.id, prompt: finalPrompt, preset: presetId || undefined, ratio, resolution, ...(model?.durations?.length ? { duration: Number(duration) } : {}), batchSize: Number(batchSize), client });

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
  const ready = !!model && (preset !== null || finalPrompt.trim().length > 0) && blanks.length === 0 && !busy && !viewer;
  const cap = effectiveCap(data);
  const heading = preset ? preset.label : template ? template.title : "Your own prompt";

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start", minWidth: 0 }}>
        <div style={{ flex: "999 1 520px", minWidth: 0, maxWidth: "100%", order: narrow ? 1 : 0 }}>
          <TemplateGallery companyId={companyId} saved={saved} selectedId={template?.id ?? ""} presetId={presetId} onPick={pickTemplate} onPickPreset={pickPreset} onUsePrompt={setPrompt} problem={savedProblem} />
        </div>
        <section
          ref={composerRef}
          aria-label="Compose"
          style={{ flex: "1 1 400px", minWidth: 0, maxWidth: "100%", order: narrow ? 0 : 1, position: narrow ? undefined : "sticky", top: 0, maxHeight: narrow ? undefined : "calc(100vh - 110px)", overflowY: narrow ? undefined : "auto", display: "grid", gap: 12, padding: 16, borderRadius: 12, border: "1px solid var(--border)", background: "var(--card)" }}
        >
          <div style={{ ...row, justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 15, minWidth: 0, overflowWrap: "anywhere" }}>{heading}</strong>
            {preset || template ? <Button variant="secondary" style={{ height: 28, fontSize: 12 }} onClick={startBlank}>Start blank</Button> : null}
          </div>
          {cap ? <ProgressBar done={roundCredits(data.companyUsed)} total={cap.monthlyCredits} tone="budget" label="Credits this month" size="sm" /> : null}
          {viewer ? <PageMessage tone="warning" message="Viewers can look at Studio but can't generate. Ask a company owner for member access." /> : null}
          {models.length === 0 ? <PageMessage tone="warning" message="No fixed-price models are offered yet." /> : null}
          {fieldNames.map((name) => (
            <Field key={name} label={fieldLabel(name)}>
              <Input aria-label={fieldLabel(name)} value={fields[name] ?? ""} placeholder={template?.examples?.[name] ? `For example: ${template.examples[name]}` : undefined} onChange={(e) => setFields((f) => ({ ...f, [name]: e.target.value }))} />
            </Field>
          ))}
          <Field label={preset ? "Extra direction (optional)" : fieldNames.length ? "Template" : "Prompt"}>
            <textarea
              aria-label="Prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={fieldNames.length ? 5 : 6}
              maxLength={preset ? PHOTO_NOTE_MAX : 4000}
              placeholder={preset ? `Optional note, up to ${PHOTO_NOTE_MAX} characters` : "Describe what you want, or pick a template. Use {{name}} to make a field you fill in each time."}
              style={{ width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, lineHeight: 1.45, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", resize: "vertical" }}
            />
          </Field>
          {preset ? <p style={{ ...muted, margin: 0 }}>{preset.label} builds the prompt for you. Best with {preset.subject === "any" ? "anything" : `a ${preset.subject}`}.</p> : null}
          {blanks.length ? <p style={{ ...muted, margin: 0 }}>Still to fill in: {blanks.map(fieldLabel).join(", ")}.</p> : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(150px, 100%), 1fr))", gap: 10 }}>
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
            {model?.kind === "video" ? (
              <Field label="Duration (seconds)">
                <div role="group" aria-label="Duration" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {durationChips(model).map((c) => (
                    <Button key={c.value} variant={duration === c.value && !c.disabled ? "primary" : "secondary"} aria-pressed={duration === c.value} disabled={c.disabled !== null} title={c.disabled ?? undefined} onClick={() => setDuration(c.value)}>
                      {c.value}
                    </Button>
                  ))}
                </div>
                {disabledNote(durationChips(model), model) ? <span role="note">{disabledNote(durationChips(model), model)}</span> : null}
              </Field>
            ) : null}
            <Field label="Batch size">
              <Select aria-label="Batch size" value={batchSize} onChange={(e) => setBatchSize(e.target.value)}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {!preset ? <BrandKitBox companyId={companyId} client={client} prompt={prompt} disabled={busy} onAdd={setPrompt} /> : null}
          {message ? <PageMessage tone={message.tone} message={message.text} /> : null}
          {estimate ? (
            <div style={{ ...row }} aria-live="polite">
              <strong>
                {estimate.creditsTotal} credits ({estimate.batchSize} × {estimate.creditsEach})
              </strong>
              <span style={muted}>{estimate.monthlyCap === null ? "No cap is set, so generation is off." : `${estimate.remaining} of ${estimate.monthlyCap} left this month.`}</span>
            </div>
          ) : null}
          <div style={row}>
            <Button variant="secondary" disabled={!ready} onClick={() => void runEstimate()}>
              Estimate
            </Button>
            <Button disabled={!ready || !estimate} onClick={() => void runGenerate()}>
              {busy ? "Working…" : estimate ? `Generate for ${estimate.creditsTotal} credits` : "Generate"}
            </Button>
          </div>
          {!estimate ? <span style={muted}>Estimate first: it shows the cost before anything is charged.</span> : null}
          {!preset && !viewer && prompt.trim() ? (
            naming === null ? (
              <div style={{ ...row, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <Button variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => setNaming(template?.category === "saved" ? `${template.title} copy` : template?.title ?? "")}>
                  Save as template
                </Button>
                {template?.category === "saved" ? (
                  <Button variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => void removeTemplate(template)}>
                    Delete template
                  </Button>
                ) : null}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <Field label="Template name">
                  <Input aria-label="Template name" value={naming} maxLength={80} autoFocus onChange={(e) => setNaming(e.target.value)} />
                </Field>
                <div style={row}>
                  <Button disabled={busy || !naming.trim()} style={{ height: 30, fontSize: 12.5 }} onClick={() => void saveAsTemplate()}>
                    Save
                  </Button>
                  <Button variant="secondary" disabled={busy} style={{ height: 30, fontSize: 12.5 }} onClick={() => setNaming(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </section>
      </div>
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

function CapRow({ label, hint, scopeKey, cap, used, save, busy, editable, unit = "monthly credits" }: { unit?: string; label: string; hint: string; scopeKey: string; cap: Cap | undefined; used?: number; save: (scopeKey: string, value: string) => void; busy: boolean; editable: boolean }) {
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
            <Input aria-label={`${label} ${unit}`} type="number" min={0} step="any" placeholder="Not set" value={value} onChange={(event) => setValue(event.target.value)} />
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
  const setAgentLimit = useStudioAction("set-agent-limit");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [addClient, setAddClient] = useState("");
  const owner = me?.isOwner === true;

  const capOf = (key: string) => data.caps.find((c) => c.scopeKey === key);
  const agentName = (id: string) => data.agents?.find((a) => a.id === id)?.name ?? id;
  const nameOf = (key: string) => (key.startsWith(AGENT_LIMIT_PREFIX) ? `${agentName(key.slice(AGENT_LIMIT_PREFIX.length))} (per run)` : key === DEFAULT_SCOPE ? "Default" : key === COMPANY_SCOPE ? "Company" : key === AGENT_RUN_SCOPE ? "Per agent run" : (data.clients.find((c) => c.scopeKey === key)?.name ?? key));
  const clientCaps = data.caps.filter((c) => c.scopeKey.includes(":") && !c.scopeKey.startsWith(AGENT_LIMIT_PREFIX));
  const agentCaps = data.caps.filter((c) => c.scopeKey.startsWith(AGENT_LIMIT_PREFIX));
  const agentAdmin = me?.canSetAgentLimit === true || owner;
  const addableAgents = (data.agents ?? []).filter((a) => !capOf(`${AGENT_LIMIT_PREFIX}${a.id}`));
  const [addAgent, setAddAgent] = useState("");
  const runDefault = capOf(AGENT_RUN_SCOPE)?.monthlyCredits ?? DEFAULT_RUN_LIMIT;
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

  async function saveAgent(scopeKey: string, value: string) {
    setBusy(true);
    setMessage(null);
    try {
      await setAgentLimit({ companyId, agentId: scopeKey.slice(AGENT_LIMIT_PREFIX.length), credits: value.trim() === "" ? null : Number(value) });
      refresh();
      setMessage({ text: `${nameOf(scopeKey)} limit saved. It applies to that agent's next generation.`, tone: "success" });
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
      <MetricRow>
        <MetricCard icon={Coins} value={roundCredits(data.companyUsed)} label="Credits used" description={`In ${data.period}`} />
        {effectiveCap(data) ? <CreditsMetric data={data} /> : null}
        <MetricCard icon={Gauge} value={effectiveCap(data)?.monthlyCredits ?? "–"} label="Monthly cap" description={data.caps.some((c) => c.scopeKey === COMPANY_SCOPE) ? "Company cap" : effectiveCap(data) ? "Default cap" : "Not set"} />
        <MetricCard icon={Building2} value={data.clientUsage.filter((c) => c.used > 0).length} label="Clients with spend" description="This month" />
      </MetricRow>
      {data.clientUsage.some((c) => c.used > 0) ? (
        <Section title="Credits by client">
          <BarList
            bare
            title="Credits by client"
            items={data.clientUsage.filter((c) => c.used > 0).sort((a, b) => b.used - a.used).map((c) => ({ label: data.clients.find((k) => k.scopeKey === c.scopeKey)?.name ?? c.scopeKey, value: roundCredits(c.used) }))}
          />
        </Section>
      ) : null}
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
      </Section>
      <Section title="Credits per agent run">
        <p style={{ ...muted, marginBottom: 8 }}>
          The most one agent run may spend. Above it the agent is refused, told nothing was started, and sent to the Creative Producer. The monthly cap still applies to everyone. People on this page are not limited by it.
        </p>
        <CapRow
          label="All agents"
          hint={`Used by an agent with no limit of its own. Blank uses the default of ${DEFAULT_RUN_LIMIT} credits.`}
          unit="credits per run"
          scopeKey={AGENT_RUN_SCOPE}
          cap={capOf(AGENT_RUN_SCOPE)}
          save={save}
          busy={busy}
          editable={owner}
        />
        {agentCaps.length === 0 ? <div style={{ ...muted, padding: "10px 0" }}>No agent has its own limit. Every agent gets {runDefault} credits per run.</div> : null}
        {agentCaps.map((c) => (
          <CapRow key={c.scopeKey} label={agentName(c.scopeKey.slice(AGENT_LIMIT_PREFIX.length))} hint="This agent's own limit. 0 stops it generating." unit="credits per run" scopeKey={c.scopeKey} cap={c} save={saveAgent} busy={busy} editable={agentAdmin} />
        ))}
        {agentAdmin && addableAgents.length > 0 ? (
          <div style={{ ...row, paddingTop: 12 }}>
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <Select aria-label="Agent" value={addAgent} onChange={(event) => setAddAgent(event.target.value)}>
                <option value="">Set a limit for an agent…</option>
                {addableAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.title ? ` · ${a.title}` : ""}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              disabled={busy || !addAgent}
              onClick={() => {
                const id = addAgent;
                setAddAgent("");
                void saveAgent(`${AGENT_LIMIT_PREFIX}${id}`, String(runDefault));
              }}
            >
              Add
            </Button>
          </div>
        ) : null}
        <p style={{ ...muted, marginTop: 12 }}>{agentAdmin ? "Add an agent, then set its credits per run. Leave it blank to go back to the company limit." : "Only a company owner or admin can change an agent's limit."}</p>
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
  // The Cockpit's Marketing group shows this page instead (pib-plugin-ui NAV_GROUPS); keep our own row only until that group exists.
  const grouped = useGroupedNav("partnersinbiz.studio");
  const navigation = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname === navigation.resolveHref("/studio") || location.pathname === navigation.resolveHref("/studio-canvas");
  if (grouped !== false) return null;
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
