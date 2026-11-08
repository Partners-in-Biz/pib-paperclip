import { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, PageMessage, SectionHeading, Select, errorText, seriesColor, tone } from "@partnersinbiz/pib-plugin-ui";
import { NODE_TYPES, type CanvasDoc, type NodeType } from "../canvas-rules.js";
import { boardFieldLabel, boardFields, boardSummary, CANVAS_TEMPLATE_CATEGORIES, CANVAS_TEMPLATES, fillBoard, filterCanvasTemplates, type CanvasTemplate } from "../canvas-templates.js";
import { useStudioAction } from "./action.js";
import { ChipGroup } from "./ChipGroup.js";

const MUTED = "var(--muted-foreground)";
const CARD_W = 300;
const CARD_H = 150;

/** A small map of the board: the cards and how they connect, so you can see the shape of the work before starting. */
export function BoardPreview({ doc }: { doc: CanvasDoc }) {
  const pos = new Map(doc.nodes.map((n) => [n.id, n.position]));
  const xs = doc.nodes.map((n) => n.position.x);
  const ys = doc.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs, 0);
  const minY = Math.min(...ys, 0);
  const width = Math.max(...xs, 0) - minX + CARD_W;
  const height = Math.max(...ys, 0) - minY + CARD_H;
  const colour = (type: NodeType) => seriesColor(NODE_TYPES.indexOf(type));
  return (
    <svg viewBox={`${minX - 30} ${minY - 30} ${width + 60} ${height + 60}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" style={{ display: "block", width: "100%", height: "100%" }}>
      {doc.edges.map((e) => {
        const a = pos.get(e.source);
        const b = pos.get(e.target);
        if (!a || !b) return null;
        const x1 = a.x + CARD_W;
        const y1 = a.y + CARD_H / 2;
        const x2 = b.x;
        const y2 = b.y + CARD_H / 2;
        const mid = (x1 + x2) / 2;
        return <path key={e.id} d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.45" strokeWidth="6" />;
      })}
      {doc.nodes.map((n) => (
        <rect key={n.id} x={n.position.x} y={n.position.y} width={CARD_W} height={CARD_H} rx="22" fill={`color-mix(in oklab, ${colour(n.type)} 38%, var(--background))`} stroke={colour(n.type)} strokeWidth="5" />
      ))}
    </svg>
  );
}

function Start({ template, companyId, clients, onClose, onCreated, onDeleted }: {
  template: CanvasTemplate;
  companyId: string;
  clients: Array<{ scopeKey: string; name: string }>;
  onClose: () => void;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const create = useStudioAction("canvas-create");
  const remove = useStudioAction("delete-canvas-template");
  const fields = useMemo(() => boardFields(template.doc), [template]);
  const [title, setTitle] = useState(template.title);
  const [client, setClient] = useState("own");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = template.category === "saved";

  async function go() {
    setBusy(true);
    setProblem(null);
    try {
      const out = (await create({ companyId, title: title.trim() || template.title, doc: fillBoard(template.doc, values), ...(client === "own" ? {} : { client }) })) as { id: string };
      onCreated(out.id);
    } catch (err) {
      setProblem(errorText(err));
      setBusy(false);
    }
  }
  async function drop() {
    if (!window.confirm(`Delete the template "${template.title}"? Boards already made from it stay.`)) return;
    setBusy(true);
    try {
      await remove({ companyId, id: template.id });
      onDeleted(template.id);
    } catch (err) {
      setProblem(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      width={620}
      title={template.title}
      description={`${template.tagline}. ${boardSummary(template.doc)}. Nothing is made or charged until you press Generate on a card.`}
      onClose={onClose}
      footer={
        <>
          {saved ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void drop()}>Delete template</Button> : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" disabled={busy} onClick={() => void go()}>{busy ? "Creating…" : "Create board"}</Button>
        </>
      }
    >
      <div style={{ height: 170, borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}><BoardPreview doc={template.doc} /></div>
      {problem ? <PageMessage tone="danger" message={problem} /> : null}
      <Field label="Board name"><Input aria-label="Board name" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="For">
        <Select aria-label="For client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="own">Own work</option>
          {clients.map((c) => <option key={c.scopeKey} value={c.scopeKey}>{c.name}</option>)}
        </Select>
      </Field>
      {fields.map((name) => (
        <Field key={name} label={boardFieldLabel(name)}>
          <Input aria-label={boardFieldLabel(name)} value={values[name] ?? ""} placeholder={template.examples[name] ? `For example: ${template.examples[name]}` : undefined} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} />
        </Field>
      ))}
      {fields.length ? <span style={{ fontSize: 12.5, color: MUTED }}>Anything you leave blank stays on the card, to fill in there.</span> : null}
    </Modal>
  );
}

/** Starter boards and the company's saved ones. Picking one asks for a few details and opens a board wired and ready. */
export function CanvasTemplateGallery({ companyId, clients, canEdit, onCreated }: { companyId: string; clients: Array<{ scopeKey: string; name: string }>; canEdit: boolean; onCreated: (id: string) => void }) {
  const list = useStudioAction("canvas-templates");
  const [saved, setSaved] = useState<CanvasTemplate[]>([]);
  const [category, setCategory] = useState("");
  const [open, setOpen] = useState<CanvasTemplate | null>(null);
  useEffect(() => {
    let live = true;
    list({ companyId }).then((out) => live && setSaved((out as { saved: CanvasTemplate[] }).saved)).catch(() => undefined);
    return () => {
      live = false;
    };
    // `list` is a new function each render; the list depends only on the company.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);
  const shown = [...filterCanvasTemplates(saved, { category }), ...filterCanvasTemplates(CANVAS_TEMPLATES, { category })];
  const options: Array<[string, string, number?]> = [["", "All"], ...(saved.length ? [["saved", "Yours", saved.length] as [string, string, number]] : []), ...CANVAS_TEMPLATE_CATEGORIES.map((c): [string, string] => [c.id, c.label])];
  return (
    <section style={{ display: "grid", gap: 12, minWidth: 0 }} aria-label="Start from a template">
      <SectionHeading title="Start from a template" actions={<ChipGroup label="Category" value={category} onChange={setCategory} options={options} />} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))", gap: 12, minWidth: 0 }}>
        {shown.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!canEdit}
            title={canEdit ? undefined : "Viewers can look at Studio but can't create boards."}
            onClick={() => setOpen(t)}
            className="pib-link-card"
            style={{ padding: 0, textAlign: "left", font: "inherit", color: "inherit", cursor: canEdit ? "pointer" : "default", overflow: "hidden", minWidth: 0, display: "flex", flexDirection: "column", borderRadius: 12, border: "1px solid var(--border)", background: "color-mix(in oklab, var(--background) 70%, transparent)" }}
          >
            <span style={{ display: "block", width: "100%", height: 130, padding: 8, background: `radial-gradient(120% 140% at 0% 0%, color-mix(in oklab, ${tone("accent").solid} 12%, transparent), transparent 62%)` }}><BoardPreview doc={t.doc} /></span>
            <span style={{ display: "grid", gap: 2, padding: "10px 12px 12px", minWidth: 0, width: "100%", borderTop: "1px solid var(--border)" }}>
              <span style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
              <span style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.35, overflowWrap: "anywhere" }}>{t.tagline}</span>
              <span style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{boardSummary(t.doc)}</span>
            </span>
          </button>
        ))}
      </div>
      {open ? (
        <Start
          key={open.id}
          template={open}
          companyId={companyId}
          clients={clients}
          onClose={() => setOpen(null)}
          onCreated={onCreated}
          onDeleted={(id) => {
            setSaved((items) => items.filter((t) => t.id !== id));
            setOpen(null);
          }}
        />
      ) : null}
    </section>
  );
}
