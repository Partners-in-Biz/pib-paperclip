import { useEffect, useMemo, useRef, useState } from "react";
import { useHostContext, useHostLocation, useHostNavigation, usePluginAction, usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ClientCards } from "./ClientCards.js";
import { Button, errorText, Field, Input, Page, PageMessage, Section, Select, usePibBaseStyles } from "@partnersinbiz/pib-plugin-ui";

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
const COMPANY_SCOPE = "company";
const FINISHED = new Set(["succeeded", "failed"]);
const STATUSES = ["draft", "approved", "rejected", "archived"];
/** The server's signed links last 5 minutes; fetch fresh ones before that. */
const URL_REFRESH_MS = 4 * 60 * 1000;
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
  const meAction = usePluginAction("me");
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("library");
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [libraryClient, setLibraryClient] = useState<{ value: string; n: number } | null>(null);

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
    <Page title="Studio" description={`Credits used in ${data.period}: ${data.companyUsed}`}>
      {meError ? <PageMessage tone="danger" message={meError} /> : null}
      <div role="tablist" aria-label="Studio" style={{ ...row, marginBottom: 12 }}>
        {tabs.map(([key, label]) => (
          <Button key={key} role="tab" aria-selected={tab === key} variant={tab === key ? "primary" : "secondary"} onClick={() => setTab(key)}>
            {label}
          </Button>
        ))}
      </div>
      {tab === "library" ? <ClientCards companyId={companyId} version={libraryVersion} onOpenLibrary={(value) => setLibraryClient((prev) => ({ value, n: (prev?.n ?? 0) + 1 }))} /> : null}
      {tab === "library" ? <Library companyId={companyId} data={data} version={libraryVersion} presetClient={libraryClient} /> : null}
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
    </Page>
  );
}

/** Fresh signed preview links for these assets, renewed before they expire. People only: agents never get links. */
function usePreviewUrls(companyId: string, ids: string[]): { urls: Record<string, string>; error: string | null } {
  const assetUrls = usePluginAction("asset-urls");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const key = ids.join(",");
  useEffect(() => {
    if (!key) {
      setUrls({});
      return;
    }
    let live = true;
    const load = () =>
      assetUrls({ companyId, assetIds: key.split(",") })
        .then((out) => {
          if (!live) return;
          setUrls((out as { urls?: Record<string, string> }).urls ?? {});
          setError(null);
        })
        .catch((err) => {
          if (live) setError(errorText(err));
        });
    void load();
    const timer = setInterval(() => void load(), URL_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [companyId, key]);
  return { urls, error };
}

function Preview({ kind, name, url, height = 160 }: { kind: string; name: string; url: string | undefined; height?: number }) {
  const box = { width: "100%", height, objectFit: "cover" as const, borderRadius: 8, background: "rgba(127,127,127,0.12)", display: "block" };
  if (!url) return <div style={{ ...box, display: "grid", placeItems: "center", ...muted }}>{kind}</div>;
  if (kind === "video") return <video src={url} style={box} muted playsInline controls preload="metadata" />;
  return <img src={url} alt={name} style={box} loading="lazy" />;
}

function Library({ companyId, data, version, presetClient }: { companyId: string; data: Overview; version: number; presetClient: { value: string; n: number } | null }) {
  const [client, setClient] = useState(presetClient?.value ?? "");
  useEffect(() => {
    if (presetClient) setClient(presetClient.value);
  }, [presetClient]);
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const params = useMemo(() => ({ companyId, client, projectId, kind, status, limit: 60, v: `${version}.${reviewed}` }), [companyId, client, projectId, kind, status, version, reviewed]);
  const assets = usePluginData<{ assets: Asset[] }>("assets", params);
  const list = assets.data?.assets ?? [];
  const previews = usePreviewUrls(companyId, list.map((a) => a.id));
  const open = list.find((a) => a.id === openId);

  return (
    <>
      <Section title="Library">
        <div style={{ ...grid(160), marginBottom: 12 }}>
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
          <Field label="Kind">
            <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option>
              <option value="image">Images</option>
              <option value="video">Videos</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {assets.error ? <PageMessage tone="danger" message={errorText(assets.error)} /> : null}
        {previews.error ? <PageMessage tone="warning" message={`Previews: ${previews.error}`} /> : null}
        {!assets.data && !assets.error ? <div style={muted}>Loading…</div> : null}
        {assets.data && list.length === 0 ? <div style={muted}>No assets match these filters.</div> : null}
        <div style={grid(180)}>
          {list.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpenId(a.id)}
              aria-label={`Open ${a.name}`}
              style={{ textAlign: "left", background: "transparent", border: "1px solid var(--border)", borderRadius: 10, padding: 8, cursor: "pointer", color: "inherit", minWidth: 0, font: "inherit" }}
            >
              <Preview kind={a.kind} name={a.name} url={previews.urls[a.id]} />
              <div style={{ fontWeight: 600, marginTop: 6, overflowWrap: "anywhere" }}>{a.name}</div>
              <div style={{ ...muted, overflowWrap: "anywhere" }}>
                {a.kind} · {a.status} · {a.client?.name ?? "Own work"}
              </div>
            </button>
          ))}
        </div>
      </Section>
      {openId ? <AssetDetail companyId={companyId} assetId={openId} kind={open?.kind ?? "image"} previewUrl={previews.urls[openId]} close={() => setOpenId(null)} onReviewed={() => setReviewed((n) => n + 1)} /> : null}
    </>
  );
}

function AssetDetail({
  companyId,
  assetId,
  kind,
  previewUrl,
  close,
  onReviewed,
}: {
  companyId: string;
  assetId: string;
  kind: string;
  previewUrl: string | undefined;
  close: () => void;
  onReviewed: () => void;
}) {
  const [v, setV] = useState(0);
  const detailParams = useMemo(() => ({ companyId, assetId, v }), [companyId, assetId, v]);
  const detail = usePluginData<Detail>("asset", detailParams);
  const assetUrl = usePluginAction("asset-url");
  const reviewAction = usePluginAction("review");
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
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [assetId]);

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
    <div ref={ref}>
      <Section
        title={d?.asset.name ?? "Asset"}
        actions={
          <div style={row}>
            {d && (d.asset.status === "draft" || d.asset.status === "rejected") ? (
              <Button disabled={busy} onClick={() => void review("approved")}>
                Approve
              </Button>
            ) : null}
            {d && d.asset.status === "draft" ? (
              <Button variant="secondary" disabled={busy} onClick={() => void review("rejected")}>
                Reject
              </Button>
            ) : null}
            <Button onClick={() => void download()}>Download</Button>
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
              <dd style={term}>{d.madeBy.agentId ? `Agent ${d.madeBy.agentId}` : d.madeBy.userId ? `Person ${d.madeBy.userId}` : "—"}</dd>
              <dt style={muted}>Issue</dt>
              <dd style={term}>{d.issue ? `${d.issue.identifier ?? d.issue.id}${d.issue.title ? `: ${d.issue.title}` : ""}` : "—"}</dd>
              <dt style={muted}>Client</dt>
              <dd style={term}>{d.asset.client?.name ?? "Own work"}</dd>
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
  const models = data.models ?? [];
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((m) => m.id === modelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState(model?.ratios[0] ?? "");
  const [resolution, setResolution] = useState(model?.resolutions[0] ?? "");
  const [batchSize, setBatchSize] = useState("1");
  const [client, setClient] = useState("own");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<string[]>([]);
  const estimateAction = usePluginAction("estimate");
  const generateAction = usePluginAction("generate");

  useEffect(() => {
    if (!model) return;
    if (!model.ratios.includes(ratio)) setRatio(model.ratios[0] ?? "");
    if (!model.resolutions.includes(resolution)) setResolution(model.resolutions[0] ?? "");
  }, [model?.id]);
  // Any change to the request makes the shown price stale.
  useEffect(() => setEstimate(null), [modelId, prompt, ratio, resolution, batchSize, client]);

  const request = () => ({ companyId, model: model?.id, prompt, ratio, resolution, batchSize: Number(batchSize), client });

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
  const ready = !!model && prompt.trim().length > 0 && !busy && !viewer;

  return (
    <>
      <Section title="Generate">
        {viewer ? <PageMessage tone="warning" message="Viewers can look at Studio but can't generate. Ask a company owner for member access." /> : null}
        {models.length === 0 ? <PageMessage tone="warning" message="No fixed-price models are offered yet." /> : null}
        <div style={grid(160)}>
          <Field label="Model">
            <Select aria-label="Model" value={model?.id ?? ""} onChange={(e) => setModelId(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
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
          <Field label="Prompt">
            <textarea
              aria-label="Prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="Describe the image"
              style={{ width: "100%", boxSizing: "border-box", font: "inherit", padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit", resize: "vertical" }}
            />
          </Field>
        </div>
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
  const setCap = usePluginAction("set-cap");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const [addClient, setAddClient] = useState("");
  const owner = me?.isOwner === true;

  const capOf = (key: string) => data.caps.find((c) => c.scopeKey === key);
  const nameOf = (key: string) => (key === DEFAULT_SCOPE ? "Default" : key === COMPANY_SCOPE ? "Company" : (data.clients.find((c) => c.scopeKey === key)?.name ?? key));
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
