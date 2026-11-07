/**
 * The canvas side panel: opens when one card is selected. Tabs Configure, Review, Provenance, Export. Configure is the
 * old canvas's generate form (prompt, model, aspect / resolution / quality chips, batch stepper, "Generate for N
 * credits") on the same estimate -> confirm flow as before. A chip the chosen model doesn't accept stays visible and
 * disabled with the reason (canvas-settings.ts).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { useStudioAction } from "./action.js";
import { useMakerLabel } from "./maker.js";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { MAX_TEXT } from "../canvas-rules.js";
import { modelOptions, type CardInputs } from "../canvas-inputs.js";
import { CommentsThread } from "./Versions.js";
import { SaveToDrive } from "./SaveToDrive.js";
import { ModelPicker } from "./ModelPicker.js";
import { BrandKitBox } from "./BrandKit.js";
import { LayoutConfigure, TextConfigure } from "./LayoutCard.js";
import { aspectChips, BATCH_MAX, clampBatch, disabledNote, effectiveValue, qualityChips, resolutionChips, type Chip } from "../canvas-settings.js";

export interface PanelModel { id: string; label: string; kind: "image" | "video"; ratios: string[]; resolutions: string[]; minRefs?: number; maxRefs?: number }
export interface PanelUnavailable { id: string; label: string; kind: "image" | "video"; note: string }
export interface Estimate { creditsEach: number; creditsTotal: number; monthlyCap: number | null; remaining: number }
export interface PanelCard { id: string; type: string; data: Record<string, string> }

const TABS = ["Configure", "Review", "Provenance", "Export", "Comments"] as const;
type Tab = (typeof TABS)[number];
const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)", overflowWrap: "anywhere" };
const field: CSSProperties = { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--background)", color: "var(--foreground)" };
const group: CSSProperties = { display: "grid", gap: 4 };
const wrap: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };

export interface PanelProps {
  card: PanelCard;
  companyId: string;
  canvasId: string;
  /** The signed-in person, to mark their own comments. */
  meUserId: string | null;
  client: string;
  canGenerate: boolean | null;
  models: PanelModel[];
  unavailable: PanelUnavailable[];
  inputs: CardInputs;
  assetStatus: string | undefined;
  /** Edits the card's data (undo-aware). */
  edit: (patch: Record<string, string>) => void;
  /** Takes the undo step for a text field; called when it gets focus. */
  beforeEdit: () => void;
  onGenerated: (groupId: string) => void;
  onBuildOn: () => void;
  /** For Layout and Text cards: how many parts the connected words have, and how many pages the words feed. */
  layoutParts?: number;
  textPages?: number;
  boardTitle?: string;
  boardClient?: string | null;
  boardProjectId?: string | null;
  /** Deletes the card from the board (asks first when it shows a file); missing while the board is locked. */
  onDelete?: () => void;
  onClose: () => void;
}

export function SidePanel(props: PanelProps) {
  const [tab, setTab] = useState<Tab>("Configure");
  return (
    <aside aria-label="Card settings" className="studio-canvas-panel">
      <div style={{ ...wrap, justifyContent: "space-between", flexWrap: "nowrap" }}>
        <strong style={{ textTransform: "uppercase", fontSize: 12, letterSpacing: 0.4 }}>{props.card.data.label || props.card.type}</strong>
        <Button variant="secondary" aria-label="Close panel" onClick={props.onClose}>Close</Button>
      </div>
      <div role="tablist" aria-label="Card sections" style={{ ...wrap, gap: 4 }}>
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} style={chipStyle(tab === t, false)}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" style={{ display: "grid", gap: 10, alignContent: "start" }}>
        {tab === "Configure" ? <Configure {...props} /> : null}
        {tab === "Review" ? <Review {...props} /> : null}
        {tab === "Provenance" ? <Provenance {...props} /> : null}
        {tab === "Export" ? <Export {...props} /> : null}
        {tab === "Comments" ? <CommentsThread companyId={props.companyId} canvasId={props.canvasId} cardId={props.card.id} canEdit={props.canGenerate === true} meUserId={props.meUserId} /> : null}
      </div>
      {props.onDelete ? (
        <div style={{ ...group, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <div style={wrap}>
            <Button variant="secondary" onClick={props.onDelete} style={{ color: "var(--destructive)" }}>Delete card</Button>
          </div>
          <span style={muted}>{props.card.data.assetId ? "Removes the card and its connections from this board. The library file stays in the Studio library. Undo brings the card back." : "Removes the card and its connections from this board. Undo brings it back."}</span>
        </div>
      ) : null}
    </aside>
  );
}

function chipStyle(on: boolean, off: boolean): CSSProperties {
  return {
    font: "inherit", fontSize: 12, padding: "4px 8px", borderRadius: 999, cursor: off ? "not-allowed" : "pointer", opacity: off ? 0.5 : 1,
    border: `1px solid ${on ? "var(--primary)" : "var(--border)"}`,
    background: on ? "var(--primary)" : "var(--background)",
    color: on ? "var(--primary-foreground, var(--background))" : "var(--foreground)",
  };
}

function ChipGroup({ label, chips, value, note, onPick }: { label: string; chips: Chip[]; value: string | undefined; note: string | null; onPick: (v: string) => void }) {
  return (
    <div role="group" aria-label={label} style={group}>
      <span style={muted}>{label}</span>
      <div style={wrap}>
        {chips.map((c) => (
          <button key={c.value} type="button" disabled={c.disabled !== null} aria-pressed={value === c.value} title={c.disabled ?? undefined} onClick={() => onPick(c.value)} style={chipStyle(value === c.value && c.disabled === null, c.disabled !== null)}>
            {c.value}
          </button>
        ))}
      </div>
      {note ? <span role="note" style={muted}>{note}</span> : null}
    </div>
  );
}

function Configure(props: PanelProps) {
  const { card, edit, beforeEdit } = props;
  if (card.type === "image" || card.type === "video") return <GenerateConfigure {...props} />;
  if (card.type === "layout") return <LayoutConfigure data={card.data} edit={edit} beforeEdit={beforeEdit} parts={props.layoutParts ?? 0} />;
  if (card.type === "text") return <TextConfigure id={card.id} data={card.data} edit={edit} beforeEdit={beforeEdit} board={props.boardTitle ?? "this board"} client={props.boardClient ?? null} projectId={props.boardProjectId ?? null} canvasId={props.canvasId} pages={props.textPages ?? 0} canEdit={props.canGenerate === true} />;
  return (
    <>
      <label style={group}>
        <span style={muted}>Name</span>
        <input aria-label="Card name" maxLength={120} value={card.data.label ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ label: e.target.value })} style={field} />
      </label>
      <span style={muted}>
        {card.type === "prompt" ? "Edit the prompt on the card. It feeds the image and video cards it is wired into." : card.type === "source" ? "Pick the library file on the card." : "This card shows a result. It is filled in when a generation runs."}
      </span>
    </>
  );
}

function GenerateConfigure({ card, companyId, client, canGenerate, models, unavailable, inputs, edit, beforeEdit, onGenerated }: PanelProps) {
  const kind = card.type as "image" | "video";
  const data = card.data;
  const estimateAction = useStudioAction("estimate");
  const generateAction = useStudioAction("generate");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refs = inputs.referenceAssetIds;
  const options = modelOptions(kind, refs.length, models, unavailable);
  const model = models.find((m) => m.id === (options.find((o) => o.id === data.model && !o.disabled) ?? options.find((o) => !o.disabled))?.id);
  const ratio = effectiveValue(data.ratio, model?.ratios ?? []);
  const resolution = effectiveValue(data.resolution, model?.resolutions ?? []);
  const batch = clampBatch(data.batch);
  const ratios = aspectChips(model);
  const resolutions = resolutionChips(model);
  const qualities = qualityChips(model);
  const request = { companyId, model: model?.id, prompt: inputs.prompt, ratio, resolution, batchSize: batch, client, ...(refs.length ? { referenceAssetIds: refs } : {}) };
  const key = JSON.stringify(request);
  // Any change to what would be sent makes the shown price stale.
  useEffect(() => setEstimate(null), [key]);

  const running = Boolean(data.groupId);
  const blocker =
    canGenerate === false ? "Viewers can look at canvases but can't generate." :
    !model ? `No ${kind} model takes ${refs.length} reference image${refs.length === 1 ? "" : "s"}.` :
    !inputs.prompt ? "Wire in a prompt card or write the prompt here." :
    inputs.missing.length ? `Fix first: ${inputs.missing.join("; ")}.` : null;
  const ready = !blocker && !busy && !running && canGenerate === true;

  const run = (action: typeof estimateAction, then: (out: unknown) => void) => {
    setBusy(true);
    setError(null);
    action(request).then(then).catch((err) => setError(errorText(err))).finally(() => setBusy(false));
  };

  return (
    <>
      <label style={group}>
        <span style={muted}>Name</span>
        <input aria-label="Card name" maxLength={120} value={data.label ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ label: e.target.value })} style={field} />
      </label>
      <label style={group}>
        <span style={muted}>Prompt (added to any connected prompt cards)</span>
        <textarea aria-label="Prompt" rows={4} maxLength={MAX_TEXT} value={data.prompt ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ prompt: e.target.value })} style={{ ...field, resize: "vertical" }} />
      </label>
      <BrandKitBox companyId={companyId} client={client} prompt={data.prompt ?? ""} disabled={running || canGenerate !== true} onAdd={(prompt) => { beforeEdit(); edit({ prompt }); }} />
      <span style={muted}>
        {inputs.prompt ? `${inputs.prompt.length} characters in all` : "No prompt yet"} · {refs.length} reference{refs.length === 1 ? "" : "s"} from connected cards
      </span>
      <div style={group}>
        <span style={muted}>Model</span>
        <ModelPicker kind={kind} options={options} models={models} value={model?.id} onPick={(id) => edit({ model: id })} />
      </div>
      <ChipGroup label="Aspect ratio" chips={ratios} value={ratio} note={disabledNote(ratios, model)} onPick={(v) => edit({ ratio: v })} />
      <ChipGroup label="Resolution" chips={resolutions} value={resolution} note={disabledNote(resolutions, model)} onPick={(v) => edit({ resolution: v })} />
      <ChipGroup label="Quality" chips={qualities} value={undefined} note={disabledNote(qualities, model)} onPick={(v) => edit({ quality: v })} />
      <div style={group}>
        <span style={muted}>Batch (each one is charged)</span>
        <div style={wrap}>
          <Button variant="secondary" aria-label="Fewer" disabled={batch <= 1} onClick={() => edit({ batch: String(batch - 1) })}>−</Button>
          <strong aria-label="Batch size" style={{ minWidth: 24, textAlign: "center" }}>{batch}</strong>
          <Button variant="secondary" aria-label="More" disabled={batch >= BATCH_MAX} onClick={() => edit({ batch: String(batch + 1) })}>+</Button>
        </div>
      </div>
      {blocker && canGenerate !== null ? <span role="note" style={muted}>{blocker}</span> : null}
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span> : null}
      {estimate ? (
        <span aria-live="polite" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
          <strong>{estimate.creditsTotal} {estimate.creditsTotal === 1 ? "credit" : "credits"}.</strong> {estimate.monthlyCap === null ? "No cap is set, so generation is off." : `${estimate.remaining} of ${estimate.monthlyCap} left this month.`}
        </span>
      ) : null}
      <div className="studio-canvas-big" style={wrap}>
        {running ? <span style={muted}>Generating…</span> : estimate ? (
          <>
            <Button disabled={!ready} onClick={() => run(generateAction, (out) => { const g = (out as { groupId?: string }).groupId; setEstimate(null); if (g) onGenerated(g); })}>
              {busy ? "Working…" : `Generate for ${estimate.creditsTotal} ${estimate.creditsTotal === 1 ? "credit" : "credits"}`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setEstimate(null)}>Cancel</Button>
          </>
        ) : (
          <Button disabled={!ready} onClick={() => run(estimateAction, (out) => setEstimate(out as Estimate))}>{busy ? "Working…" : "Generate"}</Button>
        )}
      </div>
      {!estimate && !running ? <span style={muted}>You see the credit cost first, then confirm.</span> : null}
    </>
  );
}

function NoFile({ children }: { children: ReactNode }) {
  return <span style={muted}>{children}</span>;
}

function Review({ card, companyId, assetStatus, canGenerate }: PanelProps) {
  const assetId = card.data.assetId;
  const reviewAction = useStudioAction("review");
  const [status, setStatus] = useState<string | undefined>(assetStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setStatus(assetStatus), [assetStatus, assetId]);
  if (!assetId) return <NoFile>Nothing to review yet. A card with a file can be approved or rejected.</NoFile>;
  const decide = (decision: "approved" | "rejected") => {
    setBusy(true);
    setError(null);
    reviewAction({ companyId, assetId, decision }).then(() => setStatus(decision)).catch((err) => setError(errorText(err))).finally(() => setBusy(false));
  };
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Review needed";
  return (
    <>
      <span aria-label="Review status" style={{ ...muted, justifySelf: "start", padding: "1px 8px", border: "1px solid var(--border)", borderRadius: 999 }}>{label}</span>
      <div style={wrap}>
        <Button disabled={busy || canGenerate !== true || status === "approved"} onClick={() => decide("approved")}>Approve</Button>
        <Button variant="secondary" disabled={busy || canGenerate !== true || status === "rejected"} onClick={() => decide("rejected")}>Reject</Button>
      </div>
      {canGenerate === false ? <span style={muted}>Viewers can look but can't approve or reject.</span> : <span style={muted}>Approving sends the file to Social.</span>}
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span> : null}
    </>
  );
}

interface Detail {
  madeBy?: { agentId: string | null; userId: string | null };
  generation: { model: string; prompt: string; params: Record<string, unknown>; estimatedCredits: number; actualCredits: number | null; createdAt: string | null } | null;
  issue: { id: string; identifier: string | null; title: string | null } | null;
}

function Provenance({ card, companyId }: PanelProps) {
  const assetId = card.data.assetId;
  const detail = usePluginData<Detail>("asset", { companyId, assetId: assetId ?? "" });
  const maker = useMakerLabel(companyId, detail.data?.madeBy);
  if (!assetId) return <NoFile>No file yet, so no history. It shows how a file was made once a generation has run.</NoFile>;
  if (detail.error) return <span role="alert" style={{ color: "var(--destructive)", fontSize: 12 }}>{errorText(detail.error)}</span>;
  if (!detail.data) return <NoFile>Loading…</NoFile>;
  const g = detail.data.generation;
  return (
    <dl style={{ display: "grid", gap: 6, margin: 0 }}>
      <Fact term="Made by" value={maker} />
      {g ? (
        <>
          <Fact term="Model" value={g.model} />
          <Fact term="Prompt" value={g.prompt} />
          <Fact term="Settings" value={Object.entries(g.params ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") || "none"} />
          <Fact term="Credits" value={g.actualCredits === null ? `${g.estimatedCredits} estimated` : `${g.actualCredits} used`} />
          <Fact term="Created" value={g.createdAt ? new Date(g.createdAt).toLocaleString() : "unknown"} />
        </>
      ) : <NoFile>This file was added by hand, not generated.</NoFile>}
      {detail.data.issue ? <Fact term="Task" value={`${detail.data.issue.identifier ?? ""} ${detail.data.issue.title ?? ""}`.trim()} /> : null}
    </dl>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div style={group}>
      <dt style={muted}>{term}</dt>
      <dd style={{ margin: 0, fontSize: 13, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
}

function Export({ card, companyId, onBuildOn }: PanelProps) {
  const assetId = card.data.assetId;
  const nav = useHostNavigation();
  const assetUrl = useStudioAction("asset-url");
  const [error, setError] = useState<string | null>(null);
  if (!assetId) return <NoFile>No file yet. Once this card has one you can download it, open it in the library or build on it.</NoFile>;
  const download = () => {
    setError(null);
    assetUrl({ companyId, assetId }).then((out) => window.open((out as { url: string }).url, "_blank", "noopener")).catch((err) => setError(errorText(err)));
  };
  return (
    <>
      <div style={wrap}>
        <Button onClick={download}>Download</Button>
        <Button variant="secondary" onClick={onBuildOn}>Use as input</Button>
        <SaveToDrive companyId={companyId} assetId={assetId} />
      </div>
      <a {...nav.linkProps(`/studio?asset=${encodeURIComponent(assetId)}`)} style={{ fontSize: 13 }}>Open in library</a>
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{error}</span> : null}
    </>
  );
}
