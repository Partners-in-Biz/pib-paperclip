/**
 * Studio's generate card on a Planning Canvas board (PAR-14281; plan PAR-14257 D 3c): the `canvasNode` slot for an
 * embed node `{ plugin: "partnersinbiz.studio", type: "studio-generate" }`. Pick image or video and a model, write the
 * prompt, tick input cards, press Generate: Studio prices it, the person confirms that exact amount, and the output
 * lands as its own Studio media card that shows the queue state until the file is there. Logic: board-generate.ts.
 */
import { useCallback, useEffect, useState, type CSSProperties, type PointerEvent } from "react";
import type { PluginCanvasNodeProps } from "@paperclipai/plugin-sdk/ui";
import { tokens } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import {
  BOARD_MODELS, estimateFromReply, inputCandidates, isOpen, MAX_INPUTS, outputNodeOp, outputPlace, POLL_MS, queueLabel, queueStateFromReply,
  refusalText, resolveInputs, saveSettingsOp, settingsFromProps, type BoardNode, type CardSettings, type GenerateStep, type InputCandidate, type QueueState,
} from "./board-generate.js";

const frame: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, height: "100%", width: "100%", minWidth: 0, boxSizing: "border-box", padding: 12, overflowY: "auto", borderRadius: 12, background: tokens.card, color: tokens.fg, fontSize: 13 };
const label: CSSProperties = { fontSize: 12, color: tokens.muted };
const control: CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "6px 8px", borderRadius: 8, border: `1px solid ${tokens.input}`, background: tokens.bg, color: tokens.fg };
/** `inRow`: shares a row with its neighbours; otherwise full width at its own height (the card is a column). */
const button = (primary: boolean, disabled = false, inRow = true): CSSProperties => ({
  minWidth: 0, flex: inRow ? "1 1 0" : "0 0 auto", padding: "6px 10px", fontSize: 13, borderRadius: 8, border: `1px solid ${primary ? tokens.primary : tokens.border}`,
  background: primary ? tokens.primary : tokens.secondary, color: primary ? tokens.primaryFg : tokens.secondaryFg, cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
});
const line: CSSProperties = { margin: 0, fontSize: 12, color: tokens.muted, overflowWrap: "anywhere" };
const stop = (e: PointerEvent) => e.stopPropagation();

export interface GenerateCardViewProps {
  settings: CardSettings;
  canEdit: boolean;
  step: GenerateStep;
  queue: QueueState | null;
  inputs: InputCandidate[] | null;
  pickingInputs: boolean;
  onChange: (next: CardSettings, save: boolean) => void;
  onPickInputs: () => void;
  onGenerate: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The card for one state. Exported for the render harness and tests. */
export function GenerateCardView(v: GenerateCardViewProps) {
  const { settings: s, canEdit, step } = v;
  const busy = step.step === "estimating" || step.step === "sending";
  const canGo = canEdit && !busy && Boolean(s.prompt.trim()) && Boolean(s.model);
  const models = BOARD_MODELS.filter((m) => m.kind === s.kind);
  const setKind = (kind: "image" | "video") => v.onChange({ ...s, kind, model: BOARD_MODELS.find((m) => m.kind === kind)?.id ?? "" }, true);
  const toggle = (key: string) => {
    const has = s.inputKeys.includes(key);
    if (!has && s.inputKeys.length >= MAX_INPUTS) return;
    v.onChange({ ...s, inputKeys: has ? s.inputKeys.filter((k) => k !== key) : [...s.inputKeys, key] }, true);
  };
  return (
    <section aria-label="Studio generate" style={frame} data-studio-generate={step.step} className="nodrag nopan nowheel" onPointerDown={stop}>
      <strong style={{ fontSize: 13, fontWeight: 600 }}>Generate with Studio</strong>
      <div role="radiogroup" aria-label="Kind" style={{ display: "flex", gap: 6 }}>
        {(["image", "video"] as const).map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={s.kind === kind} disabled={!canEdit || busy} onClick={() => setKind(kind)} style={button(s.kind === kind, !canEdit || busy)}>
            {kind === "image" ? "Image" : "Video"}
          </button>
        ))}
      </div>
      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <span style={label}>Model</span>
        <select value={s.model} disabled={!canEdit || busy} onChange={(e) => v.onChange({ ...s, model: e.target.value }, true)} style={control}>
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <span style={label}>Prompt</span>
        <textarea value={s.prompt} rows={3} maxLength={1200} disabled={!canEdit || busy} onChange={(e) => v.onChange({ ...s, prompt: e.target.value }, false)} onBlur={() => v.onChange(s, true)} style={{ ...control, resize: "none" }} />
      </label>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <button type="button" disabled={!canEdit || busy} onClick={v.onPickInputs} aria-expanded={v.pickingInputs} style={button(false, !canEdit || busy, false)}>
          Inputs ({s.inputKeys.length}/{MAX_INPUTS})
        </button>
        {v.pickingInputs ? (
          v.inputs === null ? <p style={line}>Loading the board's Studio cards…</p>
          : v.inputs.length === 0 ? <p style={line}>No Studio image cards on this board to use as input.</p>
          : (
            <ul aria-label="Input cards" style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
              {v.inputs.map((c) => (
                <li key={c.key} style={{ minWidth: 0 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0, fontSize: 12 }}>
                    <input type="checkbox" checked={s.inputKeys.includes(c.key)} onChange={() => toggle(c.key)} disabled={!s.inputKeys.includes(c.key) && s.inputKeys.length >= MAX_INPUTS} />
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.title}>{c.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
      {step.step === "confirm" || step.step === "sending" ? (
        <div role="group" aria-label="Confirm" style={{ display: "grid", gap: 6, padding: 8, borderRadius: 8, border: `1px solid ${tokens.border}` }}>
          <p style={{ ...line, color: tokens.fg }}>{step.estimate.creditsTotal} credits, charged to {step.estimate.payer}.</p>
          <p style={line}>{step.estimate.usedToday} of {step.estimate.dailyLimit} board generations used today.</p>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" onClick={v.onCancel} disabled={step.step === "sending"} style={button(false, step.step === "sending")}>Cancel</button>
            <button type="button" onClick={v.onConfirm} disabled={step.step === "sending"} style={button(true, step.step === "sending")}>{step.step === "sending" ? "Starting…" : "Confirm"}</button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={!canGo} onClick={v.onGenerate} style={button(true, !canGo, false)}>
          {step.step === "estimating" ? "Pricing…" : "Generate…"}
        </button>
      )}
      {!canEdit ? <p style={line}>You can view this board but not generate on it.</p> : null}
      {step.step === "message" ? <p role="status" style={{ ...line, color: step.tone === "error" ? tokens.destructive : tokens.muted }}>{step.text}</p> : null}
      {v.queue ? <p role="status" aria-label="Last generation" style={line}>Last: {queueLabel(v.queue)}</p> : null}
    </section>
  );
}

async function readBoard(companyId: string, boardId: string): Promise<BoardNode[]> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/planning-canvases/${encodeURIComponent(boardId)}`, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`The board couldn't be read (HTTP ${res.status}).`);
  const body = (await res.json()) as { items?: BoardNode[] };
  return Array.isArray(body.items) ? body.items : [];
}

export function StudioGenerateCard(props: PluginCanvasNodeProps) {
  const companyId = props.context?.companyId ?? null;
  const boardScope = { projectId: props.boardProjectId ?? null };
  const canEdit = props.accessLevel === "edit";
  const estimate = useStudioAction("estimate");
  const generate = useStudioAction("generate");
  const status = useStudioAction("board-generation");
  const [settings, setSettings] = useState<CardSettings>(() => settingsFromProps(props.props));
  const [step, setStep] = useState<GenerateStep>({ step: "idle" });
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [inputs, setInputs] = useState<InputCandidate[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [outputs, setOutputs] = useState(0);

  const onChange = useCallback((next: CardSettings, save: boolean) => {
    setSettings(next);
    if (save && canEdit) void props.applyOps([saveSettingsOp(props.nodeKey, next)]).catch(() => setStep({ step: "message", text: "The card's settings weren't saved.", tone: "error" }));
  }, [canEdit, props.applyOps, props.nodeKey]);

  const onPickInputs = () => {
    const open = !picking;
    setPicking(open);
    if (!open || !companyId) return;
    setInputs(null);
    readBoard(companyId, props.boardId).then((items) => setInputs(inputCandidates(items, props.nodeKey)), () => setInputs([]));
  };

  const request = (assetIds: string[]) => ({ companyId, boardScope, model: settings.model, prompt: settings.prompt, inputKeys: settings.inputKeys, ...(assetIds.length ? { referenceAssetIds: assetIds } : {}) });

  // Every click asks for a price first; nothing runs until the person confirms that amount.
  const onGenerate = async () => {
    if (!companyId) return;
    setStep({ step: "estimating" });
    try {
      const items = await readBoard(companyId, props.boardId);
      const { assetIds, missing } = resolveInputs(items, props.nodeKey, settings.inputKeys);
      if (missing.length) return setStep({ step: "message", text: `${missing.length} input card(s) are no longer on the board or have no file. Untick them under Inputs.`, tone: "error" });
      setStep({ step: "confirm", estimate: estimateFromReply(await estimate(request(assetIds))) });
    } catch (error) {
      setStep({ step: "message", text: refusalText(error), tone: "error" });
    }
  };

  const onConfirm = async () => {
    if (step.step !== "confirm" || !companyId) return;
    setStep({ step: "sending", estimate: step.estimate });
    try {
      // The inputs are read again at the click: what Studio stores is what is wired now, never later.
      const items = await readBoard(companyId, props.boardId);
      const { assetIds, missing } = resolveInputs(items, props.nodeKey, settings.inputKeys);
      if (missing.length) return setStep({ step: "message", text: "An input card changed since the estimate. Press Generate again.", tone: "error" });
      const out = (await generate({ ...request(assetIds), expectedCredits: step.estimate.creditsTotal })) as { generationIds?: string[] };
      const id = out.generationIds?.[0];
      if (!id) throw new Error("Studio started nothing.");
      setQueue({ status: "queued", assetId: null, error: null });
      onChange({ ...settings, lastGenerationId: id }, true);
      const title = settings.prompt.trim().slice(0, 80) || "Studio generation";
      await props.applyOps([outputNodeOp({ generationId: id, title, kind: settings.kind, at: outputPlace(items, props.nodeKey, outputs) })]);
      setOutputs((n) => n + 1);
      setStep({ step: "message", text: "Queued. The result appears in its own card next to this one.", tone: "info" });
    } catch (error) {
      setStep({ step: "message", text: refusalText(error), tone: "error" });
    }
  };

  // The last generation's queue state, until it is done or failed.
  const last = settings.lastGenerationId;
  useEffect(() => {
    if (!last || !companyId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      status({ companyId, boardScope: { projectId: props.boardProjectId ?? null }, generationId: last })
        .then((out) => {
          if (!live) return;
          const q = queueStateFromReply(out);
          setQueue(q);
          if (isOpen(q)) timer = setTimeout(tick, POLL_MS);
        })
        .catch(() => {
          if (live) timer = setTimeout(tick, POLL_MS * 4);
        });
    };
    tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [last, companyId, props.boardProjectId, status]);

  return (
    <GenerateCardView settings={settings} canEdit={canEdit} step={step} queue={queue} inputs={inputs} pickingInputs={picking} onChange={onChange} onPickInputs={onPickInputs} onGenerate={() => void onGenerate()} onConfirm={() => void onConfirm()} onCancel={() => setStep({ step: "idle" })} />
  );
}
