/**
 * "Remove silences" (PAR-10183): for the selected video or sound clip, "Preview" asks `video-edit-cut-silences` for a
 * dry run (how many cuts, how many seconds go) and "Remove silences" saves exactly those ops through the store, so the
 * cuts land in the page's revision, toast and Versions list like any hand edit. Logic lives in silence-dialog.ts.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useHostContext } from "@paperclipai/plugin-sdk/ui";
import { Button, Field, Input, Modal } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "../action.js";
import type { EditorStore } from "./editor-store.js";
import { clampField, DEFAULT_SETTINGS, SILENCE_FIELDS, savedText, silenceClip, silencePlan, type SilenceField, type SilencePlan, type SilenceSettings } from "./silence-dialog.js";

/** The page's "Remove silences" button: shown while the selected clip has sound the tool can read. */
export function SilenceButton({ store }: { store: EditorStore }) {
  const { doc, selectedClipId } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [open, setOpen] = useState(false);
  const clip = silenceClip(doc, selectedClipId);
  useEffect(() => { if (!clip) setOpen(false); }, [clip?.id]);
  return (
    <>
      <Button type="button" data-silence-open disabled={!clip} title={clip ? undefined : "Select a video or sound clip first"} onClick={() => setOpen(true)}>Remove silences</Button>
      {open && clip ? <SilenceDialog store={store} clipId={clip.id} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function SilenceDialog({ store, clipId, onClose }: { store: EditorStore; clipId: string; onClose: () => void }) {
  const { edit, revision, busy } = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const companyId = useHostContext().companyId ?? "";
  const cut = useStudioAction("video-edit-cut-silences");
  const [settings, setSettings] = useState<SilenceSettings>(DEFAULT_SETTINGS);
  const [text, setText] = useState<Partial<Record<SilenceField, string>>>({});
  const [plan, setPlan] = useState<SilencePlan | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // A changed setting or any save (a trim, someone else) makes the preview stale.
  useEffect(() => { setPlan(null); }, [settings, revision]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const set = (field: SilenceField, raw: string) => {
    setText((t) => ({ ...t, [field]: raw }));
    const n = clampField(field, raw);
    if (n !== null) setSettings((s) => ({ ...s, [field]: n }));
  };
  const settle = (field: SilenceField) => setText((t) => { const { [field]: _gone, ...rest } = t; return rest; });

  const preview = async () => {
    if (!edit || revision === null || working) return;
    setWorking(true);
    setMessage(null);
    try {
      const made = silencePlan(await cut({ companyId, editId: edit.id, baseRevision: revision, clipId, ...settings, dryRun: true }));
      if (!alive.current) return;
      if (!made) setMessage("Studio sent an answer this edit can't take. Reload and try again.");
      else if (!made.cuts) setMessage("No silences found at these settings. Raise the threshold or lower the shortest silence.");
      else setPlan(made);
    } catch (err) {
      if (alive.current) setMessage(err instanceof Error && err.message ? err.message : "That didn't work. Try again.");
    } finally {
      if (alive.current) setWorking(false);
    }
  };
  const apply = async () => {
    if (!plan || busy) return;
    if (await store.applyOps(plan.ops)) return onClose();
    setMessage(store.getState().toast ?? "The cuts weren't saved.");
    store.dismissToast();
  };
  const idle = !busy && !working;

  return (
    <Modal
      open
      width={480}
      title="Remove silences"
      description="Cuts the quiet parts out of the selected clip. Later clips, captions and music move up with it."
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="secondary" data-silence-preview disabled={!idle || !edit} onClick={() => void preview()}>{working ? "Listening…" : "Preview"}</Button>
          <Button type="button" data-silence-apply disabled={!idle || !plan} onClick={() => void apply()}>{busy ? "Saving…" : plan ? `Remove ${plan.cuts} silence${plan.cuts === 1 ? "" : "s"}` : "Remove silences"}</Button>
        </>
      }
    >
      <div data-silence-dialog style={{ display: "grid", gap: 12, minWidth: 0 }}>
        {(Object.keys(SILENCE_FIELDS) as SilenceField[]).map((f) => {
          const d = SILENCE_FIELDS[f];
          return (
            <Field key={f} label={`${d.label}, ${d.min} to ${d.max}`}>
              <Input type="number" inputMode="decimal" aria-label={d.label} data-silence-field={f} min={d.min} max={d.max} step={d.step} value={text[f] ?? String(settings[f])} onChange={(e) => set(f, e.target.value)} onBlur={() => settle(f)} />
              <span style={{ fontWeight: 400, overflowWrap: "anywhere" }}>{d.hint}</span>
            </Field>
          );
        })}
        {plan ? <div data-silence-plan role="status" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{savedText(plan)}{plan.duration !== null ? ` · new length ${Math.round(plan.duration * 10) / 10} s` : ""}</div> : null}
        {message ? <div role="status" data-silence-message style={{ fontSize: 13, overflowWrap: "anywhere" }}>{message}</div> : null}
      </div>
    </Modal>
  );
}
