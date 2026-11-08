import { useEffect, useMemo, useState } from "react";
import { resolvePluginUiBase } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { Building2, Flame, Icon, Input, Megaphone, Package, SectionHeading, Share2, Sparkles, Stamp, UserRound, seriesColor, tone, type LucideIcon } from "@partnersinbiz/pib-plugin-ui";
import { PHOTO_PRESETS } from "../presets.js";
import { TEMPLATE_CATEGORIES, buildPairedPrompts, fieldLabel, filterTemplates, parsePairedPrompts, PROMPT_TEMPLATES, type PromptTemplate } from "../prompt-templates.js";
import { aspectCss } from "./card-look.js";
import { posterFrameUrl } from "./library.js";
import { ChipGroup } from "./ChipGroup.js";
import { usePreviewUrls } from "./previews.js";

const ORDER = ["product", "ads", "social", "people", "places", "food", "saved", "styles"] as const;
const ICONS: Record<(typeof ORDER)[number], LucideIcon> = { product: Package, ads: Megaphone, social: Share2, people: UserRound, places: Building2, food: Flame, saved: Stamp, styles: Sparkles };
// Not imported from namespace.ts: that file uses node:crypto, which a browser bundle can't have.
const PLUGIN_KEY = "partnersinbiz.studio";
const MUTED = "var(--muted-foreground)";
const cover = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 35%" } as const;

/**
 * A built-in image template's example picture, shipped with the plugin (the build copies `assets/template-samples` next to the page).
 * Never build this from `import.meta.url` directly: the host runs plugin pages from a blob: address, where `new URL` throws and takes the page down.
 */
const sampleUrl = (t: PromptTemplate, base: string | null) => (base && t.kind === "image" ? `${base}template-samples/${t.id}.jpg` : undefined);
const cardGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(190px, 100%), 1fr))", gap: 12, minWidth: 0 } as const;

/** A card's picture: a saved template's real result, or a tile showing the shape it is composed for. */
function Art({ family, ratio, kind, url }: { family: (typeof ORDER)[number]; ratio: string; kind: string; url?: string | undefined }) {
  const colour = seriesColor(ORDER.indexOf(family));
  const [broken, setBroken] = useState(false);
  const shown = broken ? undefined : url;
  return (
    <div style={{ position: "relative", aspectRatio: "4 / 3", width: "100%", display: "grid", placeItems: "center", overflow: "hidden", background: `radial-gradient(120% 120% at 15% 0%, color-mix(in oklab, ${colour} 42%, transparent), transparent 62%), color-mix(in oklab, ${colour} 10%, var(--background))` }}>
      {shown && kind === "video" ? (
        <video src={posterFrameUrl(shown)} muted playsInline preload="metadata" aria-hidden="true" onError={() => setBroken(true)} style={cover} />
      ) : shown ? (
        <img src={shown} alt="" loading="lazy" onError={() => setBroken(true)} style={cover} />
      ) : (
        <span aria-hidden="true" style={{ height: "58%", maxWidth: "70%", aspectRatio: ratio ? aspectCss(ratio) : "1 / 1", display: "grid", placeItems: "center", borderRadius: 6, border: `1.5px solid color-mix(in oklab, ${colour} 65%, transparent)`, background: `color-mix(in oklab, ${colour} 14%, transparent)` }}>
          <Icon icon={ICONS[family]} size={18} color={colour} />
        </span>
      )}
      {kind === "video" ? <span style={{ position: "absolute", top: 8, left: 8, padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: "color-mix(in srgb, var(--background) 76%, transparent)" }}>▶ Video</span> : null}
      {ratio ? <span style={{ position: "absolute", right: 8, bottom: 8, padding: "1px 6px", borderRadius: 6, fontSize: 11, color: MUTED, background: "color-mix(in srgb, var(--background) 76%, transparent)" }}>{ratio}</span> : null}
    </div>
  );
}

function Card({ title, tagline, selected, onPick, art }: { title: string; tagline: string; selected: boolean; onPick: () => void; art: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className="pib-link-card"
      style={{ padding: 0, textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", overflow: "hidden", minWidth: 0, display: "flex", flexDirection: "column", borderRadius: 12, border: `1px solid ${selected ? tone("accent").solid : "var(--border)"}`, boxShadow: selected ? `0 0 0 1px ${tone("accent").solid}` : undefined, background: "color-mix(in oklab, var(--background) 70%, transparent)" }}
    >
      {art}
      <span style={{ display: "grid", gap: 2, padding: "9px 11px 11px", minWidth: 0, width: "100%" }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ fontSize: 12, color: MUTED, lineHeight: 1.35, overflowWrap: "anywhere" }}>{tagline}</span>
      </span>
    </button>
  );
}

/** The form for a paired template: its fields, and two buttons that put the built JSON prompt in the prompt box. Never changes the model. */
function PairedForm({ template, onUsePrompt }: { template: PromptTemplate; onUsePrompt: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [template.id]);
  const built = buildPairedPrompts(template, values);
  const btn = { padding: "6px 12px", borderRadius: 8, border: `1px solid ${tone("accent").solid}`, background: "transparent", color: "inherit", font: "inherit", fontSize: 13, cursor: "pointer" } as const;
  return (
    <section aria-label="Paired prompt fields" style={{ display: "grid", gap: 10, minWidth: 0, padding: 12, borderRadius: 12, border: "1px solid var(--border)" }}>
      <SectionHeading title={`${template.title}: fill in the details`} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 10, minWidth: 0 }}>
        {(template.fields ?? []).map((f) => (
          <label key={f.name} style={{ display: "grid", gap: 4, fontSize: 12, color: MUTED, minWidth: 0 }}>
            {f.label || fieldLabel(f.name)}
            {f.choices?.length ? (
              <select aria-label={f.label} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} style={{ minWidth: 0, font: "inherit", padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--background)", color: "inherit" }}>
                <option value="">Choose…</option>
                {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <Input aria-label={f.label} placeholder={f.example} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            )}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" style={btn} onClick={() => onUsePrompt(built.image_prompt)}>Use image prompt</button>
        <button type="button" style={btn} onClick={() => onUsePrompt(built.video_prompt)}>Use video prompt</button>
      </div>
      <div style={{ fontSize: 12, color: MUTED }}>Fills the prompt box only. Pick the image or video model yourself.</div>
    </section>
  );
}

/** Where an agent's answer to the "Ask an agent for JSON prompts" task is pasted. Parsing is pure; the buttons only fill the prompt box. */
function PasteAgentPrompts({ onUsePrompt }: { onUsePrompt: (text: string) => void }) {
  const [text, setText] = useState("");
  const [shown, setShown] = useState(false);
  const result = text.trim() ? parsePairedPrompts(text) : null;
  const btn = { padding: "6px 12px", borderRadius: 8, border: `1px solid ${tone("accent").solid}`, background: "transparent", color: "inherit", font: "inherit", fontSize: 13, cursor: "pointer" } as const;
  return (
    <section aria-label="Paste agent prompts" style={{ display: "grid", gap: 8, minWidth: 0, padding: 12, borderRadius: 12, border: "1px solid var(--border)" }}>
      <SectionHeading title="Paste agent prompts" />
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: MUTED, minWidth: 0 }}>
        Paste the agent's answer (one json block with image_prompt and video_prompt)
        <textarea aria-label="Agent answer" rows={5} value={text} onChange={(e) => { setText(e.target.value); setShown(false); }} style={{ minWidth: 0, font: "inherit", padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--background)", color: "inherit", resize: "vertical" }} />
      </label>
      {result && !result.ok ? <div role="alert" style={{ fontSize: 13, color: tone("danger").solid, overflowWrap: "anywhere" }}>{result.message}</div> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" disabled={!result?.ok} style={btn} onClick={() => { if (result?.ok) { onUsePrompt(result.image_prompt); setShown(true); } }}>Use image prompt</button>
        <button type="button" disabled={!result?.ok} style={btn} onClick={() => { if (result?.ok) { onUsePrompt(result.video_prompt); setShown(true); } }}>Use video prompt</button>
      </div>
      <div style={{ fontSize: 12, color: MUTED }}>{shown ? "Filled the prompt box. " : ""}Fills the prompt box only. Pick the model yourself; generating still asks for a price first.</div>
    </section>
  );
}

/** Ready-made templates, the company's saved ones and the photo styles, with search and filters. Picking one fills the composer. */
export function TemplateGallery({ companyId, saved, selectedId, presetId, onPick, onPickPreset, onUsePrompt, problem }: {
  companyId: string;
  saved: PromptTemplate[];
  selectedId: string;
  presetId: string;
  onPick: (template: PromptTemplate) => void;
  onPickPreset: (id: string) => void;
  /** Puts text in the prompt box (paired templates). */
  onUsePrompt?: (text: string) => void;
  problem?: string | null;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const [uiBase, setUiBase] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void resolvePluginUiBase(PLUGIN_KEY, import.meta.url).then((base) => {
      if (live) setUiBase(base);
    });
    return () => {
      live = false;
    };
  }, []);
  const thumbs = useMemo(() => saved.map((t) => t.assetId).filter((id): id is string => Boolean(id)), [saved]);
  const previews = usePreviewUrls(companyId, thumbs);
  const needle = q.trim().toLowerCase();
  const showSaved = category === "" || category === "saved" ? filterTemplates(saved, { q, kind }) : [];
  const showBuiltIn = category === "saved" || category === "styles" ? [] : filterTemplates(PROMPT_TEMPLATES, { q, kind, category });
  const showStyles = (category === "" || category === "styles") && kind !== "video" ? PHOTO_PRESETS.filter((p) => !needle || `${p.label} ${p.tagline}`.toLowerCase().includes(needle)) : [];
  const selectedPaired = [...saved, ...PROMPT_TEMPLATES].find((t) => t.id === selectedId && t.fields?.length && t.spec);
  const nothing = showSaved.length + showBuiltIn.length + showStyles.length === 0;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", minWidth: 0 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Input aria-label="Search templates" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ChipGroup label="Kind" value={kind} onChange={setKind} options={[["", "All"], ["image", "Images"], ["video", "Videos"]]} />
      </div>
      <ChipGroup
        label="Category"
        value={category}
        onChange={setCategory}
        options={[["", "All"], ...(saved.length ? [["saved", "Yours", saved.length] as [string, string, number]] : []), ...TEMPLATE_CATEGORIES.map((c): [string, string] => [c.id, c.label]), ["styles", "Photo styles"]]}
      />
      {onUsePrompt ? <PasteAgentPrompts onUsePrompt={onUsePrompt} /> : null}
      {onUsePrompt && selectedPaired ? <PairedForm template={selectedPaired} onUsePrompt={onUsePrompt} /> : null}
      {problem ? <div style={{ fontSize: 13, color: MUTED }}>Your saved templates could not load: {problem}</div> : null}
      {nothing ? <div style={{ fontSize: 13, color: MUTED }}>No templates match. Clear the search, or write your own prompt and save it.</div> : null}
      {showSaved.length ? (
        <section style={{ display: "grid", gap: 10, minWidth: 0 }} aria-label="Your templates">
          <SectionHeading title="Your templates" />
          <div style={cardGrid}>
            {showSaved.map((t) => (
              <Card key={t.id} title={t.title} tagline={t.tagline || (t.kind === "video" ? "Saved video prompt" : "Saved image prompt")} selected={selectedId === t.id} onPick={() => onPick(t)} art={<Art family="saved" ratio={t.ratio} kind={t.kind} url={t.assetId ? previews.urls[t.assetId] : undefined} />} />
            ))}
          </div>
        </section>
      ) : null}
      {showBuiltIn.length ? (
        <section style={{ display: "grid", gap: 10, minWidth: 0 }} aria-label="Templates">
          <SectionHeading title="Templates" />
          <div style={cardGrid}>
            {showBuiltIn.map((t) => (
              <Card key={t.id} title={t.title} tagline={t.tagline} selected={selectedId === t.id} onPick={() => onPick(t)} art={<Art family={t.category} ratio={t.ratio} kind={t.kind} url={sampleUrl(t, uiBase)} />} />
            ))}
          </div>
        </section>
      ) : null}
      {showStyles.length ? (
        <section style={{ display: "grid", gap: 10, minWidth: 0 }} aria-label="Photo styles">
          <SectionHeading title="Photo styles" />
          <div style={cardGrid}>
            {showStyles.map((p) => (
              <Card key={p.id} title={p.label} tagline={p.tagline} selected={presetId === p.id} onPick={() => onPickPreset(p.id)} art={<Art family="styles" ratio="1:1" kind="image" />} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
