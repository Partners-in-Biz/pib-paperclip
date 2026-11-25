/** The Text and Layout cards: what shows on the card, the panel settings, and exporting a whole board. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useEdges, useNodes, useReactFlow, type Edge } from "@xyflow/react";
import { useHostNewIssue } from "@paperclipai/plugin-sdk/ui";
import { Button, Modal, errorText } from "@partnersinbiz/pib-plugin-ui";
import { MAX_TEXT } from "../canvas-rules.js";
import { fileStem, LAYOUT_SIZES, layoutInputs, layoutOptions, pageOrder, sizeById, splitParts, writingTaskDescription } from "../layout.js";
import { useStudioAction } from "./action.js";
import type { FlowNode } from "./board.js";
import { makePdf, makeZip } from "./export-files.js";
import { loadStudioFonts, useStudioFonts } from "./fonts.js";
import { drawPage, loadAsset, pageJpeg, saveFile, toBase64 } from "./layout-render.js";

const muted: CSSProperties = { color: "var(--muted-foreground)", fontSize: "var(--text-xs, 12px)", overflowWrap: "anywhere" };
const field: CSSProperties = { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "inherit" };
const group: CSSProperties = { display: "grid", gap: 4 };
const wrap: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };
const PREVIEW_WIDTH = 480;

function useAssetData() {
  const action = useStudioAction("asset-data");
  return useMemo(() => (companyId: string) => (assetId: string) => action({ companyId, assetId }) as Promise<{ mime: string; base64: string }>, [action]);
}

/** On the Text card: the words, and how many parts they make. */
export function TextBody({ data, beforeEdit, set }: { data: Record<string, string>; beforeEdit: () => void; set: (patch: Record<string, string>) => void }) {
  const parts = splitParts(data.text).length;
  return (
    <>
      <textarea className="nodrag nowheel" aria-label="Words" rows={6} maxLength={MAX_TEXT} placeholder="Type the words, or ask an agent to write them. A line with only --- starts the next part." value={data.text ?? ""} onFocus={beforeEdit} onChange={(e) => set({ text: e.target.value })} style={{ ...field, resize: "vertical" }} />
      <span style={muted}>{data.requested ? `Waiting for ${data.requested} to write this…` : parts > 1 ? `${parts} parts` : `${(data.text ?? "").length} / ${MAX_TEXT}`}</span>
    </>
  );
}

/** On the Layout card: a live preview with real text, and saving or downloading the finished page. */
export function LayoutBody({ id, data, companyId, canvasId, canEdit, set }: { id: string; data: Record<string, string>; companyId: string; canvasId: string; canEdit: boolean; set: (patch: Record<string, string>) => void }) {
  const nodes = useNodes<FlowNode>();
  const edges = useEdges();
  const inputs = useMemo(() => layoutInputs(nodes, edges, id), [nodes, edges, id]);
  const fetchFor = useAssetData();
  const saveAction = useStudioAction("layout-save");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = sizeById(data.size);
  const options = layoutOptions(data);
  const optionKey = JSON.stringify(options);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ready = Boolean(inputs.imageAssetId) && Boolean(inputs.text);
  const fontsReady = useStudioFonts();

  useEffect(() => {
    if (!inputs.imageAssetId) return;
    let live = true;
    loadAsset(inputs.imageAssetId, fetchFor(companyId))
      .then((img) => {
        if (!live || !canvasRef.current) return;
        const plan = drawPage(canvasRef.current, img, inputs.text, size.width, size.height, options, PREVIEW_WIDTH / size.width);
        setClipped(plan.clipped);
        setProblem(null);
      })
      .catch((err) => live && setProblem(errorText(err)));
    return () => {
      live = false;
    };
    // `options` is compared through its key; `fetchFor` only depends on the action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.imageAssetId, inputs.text, size.id, optionKey, companyId, fontsReady]);

  async function fullPage(): Promise<Uint8Array<ArrayBuffer>> {
    const canvas = document.createElement("canvas");
    await loadStudioFonts();
    const img = await loadAsset(inputs.imageAssetId as string, fetchFor(companyId));
    drawPage(canvas, img, inputs.text, size.width, size.height, options);
    return pageJpeg(canvas);
  }
  async function save() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const out = (await saveAction({ companyId, canvasId, cardId: id, name: `${data.label || "Page"} (${size.label})`, base64: toBase64(await fullPage()) })) as { assetId: string };
      set({ assetId: out.assetId });
      setNotice("Saved to the library as a draft.");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setProblem(null);
    try {
      saveFile(`${fileStem(data.label || "page", 0).slice(3) || "page"}-${size.width}x${size.height}.jpg`, await fullPage(), "image/jpeg");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="studio-media" style={{ aspectRatio: `${size.width} / ${size.height}`, maxHeight: "22rem" }}>
        {inputs.imageAssetId ? <canvas ref={canvasRef} role="img" aria-label={`Preview of ${data.label || "this page"}`} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} /> : <div className="studio-media-empty" style={{ height: "100%" }}><span style={muted}>Waiting for a picture</span></div>}
      </div>
      <span style={muted}>{size.label}: {size.width} x {size.height}{data.part ? ` · part ${data.part}` : ""}</span>
      {inputs.missing.map((m) => <span key={m} style={muted}>{m}</span>)}
      {clipped ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>The words don't fit. Shorten them or use a smaller size.</span> : null}
      {problem ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>{problem}</span> : null}
      {notice ? <span role="status" style={muted}>{notice}</span> : null}
      <div className="nodrag" style={wrap}>
        {canEdit ? <Button variant="secondary" disabled={!ready || busy} style={{ height: 28, fontSize: 12 }} onClick={() => void save()}>{busy ? "Working…" : data.assetId ? "Save again" : "Save to library"}</Button> : null}
        <Button variant="secondary" disabled={!ready || busy} style={{ height: 28, fontSize: 12 }} onClick={() => void download()}>Download</Button>
      </div>
    </>
  );
}

function Chips({ label, value, options, onPick }: { label: string; value: string; options: Array<[string, string]>; onPick: (v: string) => void }) {
  return (
    <div role="group" aria-label={label} style={group}>
      <span style={muted}>{label}</span>
      <div style={wrap}>
        {options.map(([v, text]) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onPick(v)} style={{ font: "inherit", fontSize: 12, padding: "4px 8px", borderRadius: 999, cursor: "pointer", border: `1px solid ${value === v ? "var(--primary)" : "var(--border)"}`, background: value === v ? "var(--primary)" : "var(--background)", color: value === v ? "var(--primary-foreground, var(--background))" : "var(--foreground)" }}>{text}</button>
        ))}
      </div>
    </div>
  );
}

/** Side panel settings for a Layout card. */
export function LayoutConfigure({ data, edit, beforeEdit, parts }: { data: Record<string, string>; edit: (patch: Record<string, string>) => void; beforeEdit: () => void; parts: number }) {
  const o = layoutOptions(data);
  const groups = [...new Set(LAYOUT_SIZES.map((s) => s.group))];
  return (
    <>
      <label style={group}>
        <span style={muted}>Name</span>
        <input aria-label="Card name" maxLength={120} value={data.label ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ label: e.target.value })} style={field} />
      </label>
      <label style={group}>
        <span style={muted}>Size</span>
        <select aria-label="Size" value={sizeById(data.size).id} onChange={(e) => edit({ size: e.target.value })} style={field}>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {LAYOUT_SIZES.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.width} x {s.height})</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {parts > 1 ? (
        <label style={group}>
          <span style={muted}>Which part of the words</span>
          <select aria-label="Part" value={data.part ?? ""} onChange={(e) => edit({ part: e.target.value })} style={field}>
            <option value="">All of it</option>
            {Array.from({ length: parts }, (_, i) => <option key={i} value={String(i + 1)}>Part {i + 1}</option>)}
          </select>
        </label>
      ) : null}
      <Chips label="Words go" value={o.position} options={[["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"], ["below", "Under the picture"]]} onPick={(position) => edit({ position })} />
      <Chips label="Kind of text" value={o.style} options={[["headline", "Headline"], ["body", "Paragraph"]]} onPick={(style) => edit({ style })} />
      <Chips label="Size of the words" value={o.scale} options={[["s", "Small"], ["m", "Medium"], ["l", "Large"]]} onPick={(scale) => edit({ scale })} />
      <Chips label="Align" value={o.align} options={[["center", "Centre"], ["left", "Left"]]} onPick={(align) => edit({ align })} />
      <Chips label="Font" value={o.font} options={[["sans", "Clean"], ["serif", "Book"], ["rounded", "Friendly"]]} onPick={(font) => edit({ font })} />
      <Chips label="Colour" value={o.colour} options={[["light", "White words"], ["dark", "Dark words"]]} onPick={(colour) => edit({ colour })} />
    </>
  );
}

/** Side panel for a Text card: the brief, and asking an agent to write. */
export function TextConfigure({ id, data, edit, beforeEdit, board, client, projectId, canvasId, pages, canEdit }: { id: string; data: Record<string, string>; edit: (patch: Record<string, string>) => void; beforeEdit: () => void; board: string; client: string | null; projectId: string | null; canvasId: string; pages: number; canEdit: boolean }) {
  const host = useHostNewIssue();
  const [problem, setProblem] = useState<string | null>(null);
  const ask = () => {
    setProblem(null);
    host
      .open({
        title: `Write: ${data.label || "words"} for ${board}`.slice(0, 120),
        description: writingTaskDescription({ canvasId, cardId: id, board, card: data.label || "Text", brief: data.brief ?? "", current: data.text ?? "", client, pages }),
        ...(projectId ? { projectId } : {}),
      })
      .then((issue) => {
        if (issue) edit({ requested: issue.identifier ?? "the agent" });
      })
      .catch((err: unknown) => setProblem(errorText(err)));
  };
  return (
    <>
      <label style={group}>
        <span style={muted}>Name</span>
        <input aria-label="Card name" maxLength={120} value={data.label ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ label: e.target.value })} style={field} />
      </label>
      <label style={group}>
        <span style={muted}>What should it say? (the brief for whoever writes it)</span>
        <textarea aria-label="Brief" rows={5} maxLength={MAX_TEXT} value={data.brief ?? ""} onFocus={beforeEdit} onChange={(e) => edit({ brief: e.target.value })} style={{ ...field, resize: "vertical" }} />
      </label>
      {canEdit ? <Button variant="secondary" onClick={ask}>Ask an agent to write</Button> : null}
      {problem ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>{problem}</span> : null}
      <span style={muted}>You pick the agent in the New Task window. Their words land on this card for you to check. You can also just type on the card.</span>
      {pages > 1 ? <span style={muted}>This card feeds {pages} pages: put a line with only --- between each page's words.</span> : null}
    </>
  );
}

/** Exports every finished Layout card on the board, in board order, as a ZIP of images or one PDF. */
export function ExportBoard({ open, onClose, title, companyId }: { open: boolean; onClose: () => void; title: string; companyId: string }) {
  const flow = useReactFlow<FlowNode, Edge>();
  const fetchFor = useAssetData();
  const [sizeId, setSizeId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) return null;
  const nodes = flow.getNodes();
  const edges = flow.getEdges();
  const cards = pageOrder(nodes.filter((n) => n.type === "layout"));
  const pages = cards.map((c) => ({ card: c, inputs: layoutInputs(nodes, edges, c.id) }));
  const ready = pages.filter((p) => p.inputs.imageAssetId && p.inputs.text);
  const waiting = pages.filter((p) => !(p.inputs.imageAssetId && p.inputs.text));

  async function render() {
    const out: Array<{ name: string; jpeg: Uint8Array<ArrayBuffer>; width: number; height: number }> = [];
    for (const [i, page] of ready.entries()) {
      setBusy(`Drawing page ${i + 1} of ${ready.length}…`);
      const size = sizeId ? sizeById(sizeId) : sizeById(page.card.data.size);
      const canvas = document.createElement("canvas");
      const img = await loadAsset(page.inputs.imageAssetId as string, fetchFor(companyId));
      drawPage(canvas, img, page.inputs.text, size.width, size.height, layoutOptions(page.card.data));
      out.push({ name: `${fileStem(page.card.data.label ?? "", i)}-${size.width}x${size.height}.jpg`, jpeg: await pageJpeg(canvas), width: size.width, height: size.height });
      canvas.width = 0;
    }
    return out;
  }
  const stem = fileStem(title, 0).slice(3) || "board";
  const run = (kind: "zip" | "pdf") => {
    setProblem(null);
    render()
      .then((files) => {
        if (kind === "zip") saveFile(`${stem}.zip`, makeZip(files.map((f) => ({ name: f.name, bytes: f.jpeg }))), "application/zip");
        else saveFile(`${stem}.pdf`, makePdf(files.map((f) => ({ jpeg: f.jpeg, width: f.width, height: f.height }))), "application/pdf");
        onClose();
      })
      .catch((err) => setProblem(errorText(err)))
      .finally(() => setBusy(null));
  };
  return (
    <Modal
      open
      title="Export this board"
      description={`${ready.length} of ${pages.length} pages are ready, in board order: top to bottom, then left to right.`}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="secondary" disabled={Boolean(busy) || ready.length === 0} onClick={() => run("zip")}>Download images (ZIP)</Button>
          <Button type="button" disabled={Boolean(busy) || ready.length === 0} onClick={() => run("pdf")}>Download PDF</Button>
        </>
      }
    >
      <label style={group}>
        <span style={muted}>Size</span>
        <select aria-label="Export size" value={sizeId} onChange={(e) => setSizeId(e.target.value)} style={field}>
          <option value="">As set on each card</option>
          {LAYOUT_SIZES.map((s) => <option key={s.id} value={s.id}>{s.group}: {s.label} ({s.width} x {s.height})</option>)}
        </select>
      </label>
      {busy ? <span role="status" style={muted}>{busy}</span> : null}
      {problem ? <span role="alert" style={{ ...muted, color: "var(--destructive)" }}>{problem}</span> : null}
      {waiting.length ? <span style={muted}>Not ready, so left out: {waiting.map((p) => p.card.data.label || "Layout").join(", ")}.</span> : null}
    </Modal>
  );
}
