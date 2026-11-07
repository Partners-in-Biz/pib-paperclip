/**
 * The side panel's model picker (PAR-8040 item 5): a list under a kind heading with each model's shape, references
 * and top resolution. Models the card can't use never mix into it; they collapse into "N more unavailable · Show why",
 * which lists each with its reason. The list opens in the panel's flow, so the panel's scroll never clips it.
 */
import { useEffect, useRef, useState } from "react";
import { pickerRows } from "./card-look.js";

export const pickerCss = `
.studio-picker { display: grid; gap: 0.25rem; }
.studio-picker-btn { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; width: 100%; box-sizing: border-box; font: inherit; font-size: var(--text-compact, 13px); padding: 0.375rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--background); color: var(--foreground); cursor: pointer; text-align: left; }
.studio-picker-btn > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-picker-pop { display: grid; gap: 0.125rem; max-height: 22rem; overflow-y: auto; padding: 0.375rem; border: 1px solid var(--border); border-radius: calc(var(--radius) * 1.5); background: var(--popover, var(--card)); color: var(--popover-foreground, var(--foreground)); box-shadow: var(--shadow-profile-popover); }
.studio-picker-head { padding: 0.25rem 0.5rem; font-size: var(--text-nano, 10px); letter-spacing: var(--tracking-label, 0.08em); text-transform: uppercase; color: var(--muted-foreground); }
.studio-picker-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.125rem 0.5rem; width: 100%; font: inherit; text-align: left; padding: 0.375rem 0.5rem; border: 1px solid transparent; border-radius: var(--radius); background: none; color: inherit; cursor: pointer; }
.studio-picker-row:hover, .studio-picker-row[aria-selected="true"] { background: var(--accent); }
.studio-picker-row[aria-selected="true"] { border-color: var(--ring); }
.studio-picker-row strong { font-size: var(--text-compact, 13px); min-width: 0; overflow-wrap: anywhere; }
.studio-picker-row small, .studio-picker-row > span, .studio-picker-note { font-size: var(--text-micro, 11px); color: var(--muted-foreground); overflow-wrap: anywhere; }
.studio-picker-row:focus-visible, .studio-picker-btn:focus-visible, .studio-picker-more:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.studio-picker-foot { display: grid; gap: 0.25rem; margin-top: 0.25rem; padding: 0.375rem 0.5rem 0.125rem; border-top: 1px solid var(--border); }
.studio-picker-more { font: inherit; font-size: var(--text-micro, 11px); padding: 0; border: 0; background: none; color: var(--muted-foreground); cursor: pointer; text-align: left; }
.studio-picker-more b { color: var(--foreground); font-weight: 600; }
.studio-picker-foot ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.25rem; }
`;

export function ModelPicker({ kind, options, models, value, onPick }: {
  kind: "image" | "video";
  options: ReadonlyArray<{ id: string; label: string; disabled: string | null }>;
  models: ReadonlyArray<{ id: string; ratios: string[]; resolutions: string[]; maxRefs?: number }>;
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const { rows, unavailable } = pickerRows(options, models);
  const current = rows.find((r) => r.id === value);
  return (
    <div ref={box} className="studio-picker">
      <button type="button" className="studio-picker-btn" aria-label="Model" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{current ? current.label : "No model fits"}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="studio-picker-pop">
          <div className="studio-picker-head" id={`studio-picker-${kind}`}>{kind === "image" ? "Image" : "Video"}</div>
          <div role="listbox" aria-labelledby={`studio-picker-${kind}`}>
            {rows.map((r) => (
              <button key={r.id} type="button" role="option" aria-selected={r.id === value} className="studio-picker-row" onClick={() => { onPick(r.id); setOpen(false); }}>
                <strong>{r.label}</strong>
                <span>{r.maxRes}</span>
                <small>{r.detail}</small>
              </button>
            ))}
          </div>
          {rows.length === 0 ? <span className="studio-picker-note">No {kind} model takes what is wired into this card.</span> : null}
          {unavailable.length ? (
            <div className="studio-picker-foot">
              <button type="button" className="studio-picker-more" aria-expanded={why} onClick={() => setWhy(!why)}>
                {unavailable.length} more unavailable · <b>{why ? "Hide" : "Show why"}</b>
              </button>
              {why ? (
                <ul aria-label="Unavailable models">
                  {unavailable.map((u) => <li key={u.id} className="studio-picker-note"><strong>{u.label}</strong>: {u.reason}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
