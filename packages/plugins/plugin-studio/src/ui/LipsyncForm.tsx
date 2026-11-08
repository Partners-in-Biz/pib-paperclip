/** The Generate page's Lip-sync mode (PAR-8437): portrait, audio asset or a typed line, and the model with price and note. */
import { useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText, Field, PageMessage, Select } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";
import { defaultKey, keyFor, optionsFor, optionText, problem, submitLipsync, warningFor, type LipsyncInput, type LipsyncOption } from "./lipsync-form.js";

interface PickAsset {
  id: string;
  name: string;
  kind: string;
  status: string;
}

const muted = { fontSize: 13, color: "var(--muted-foreground)", margin: 0 } as const;

export function LipsyncForm({ companyId, options, canGenerate, onQueued }: { companyId: string; options: LipsyncOption[]; canGenerate: boolean; onQueued: (groupId?: string) => void }) {
  const run = useStudioAction("studio-lipsync");
  const [input, setInput] = useState<LipsyncInput>("audio");
  const [picked, setPicked] = useState(defaultKey(options, "audio"));
  const [portraitAssetId, setPortrait] = useState("");
  const [audioAssetId, setAudio] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "danger" | "success" } | null>(null);
  const images = usePluginData<{ assets: PickAsset[] }>("assets", { companyId, kind: "image", limit: 100 });
  const audios = usePluginData<{ assets: PickAsset[] }>("assets", { companyId, kind: "audio", limit: 100 });
  const live = (kind: string) => ((kind === "image" ? images : audios).data?.assets ?? []).filter((a) => a.status !== "archived" && a.status !== "rejected");
  const provider = keyFor(options, input, picked);
  const form = { input, portraitAssetId, audioAssetId, line, provider };
  const list = optionsFor(options, input);
  const warning = warningFor(options, provider);
  const why = problem(form);

  function pickInput(next: LipsyncInput) {
    setInput(next);
    setPicked(defaultKey(options, next));
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const out = (await submitLipsync(run, form)) as { groupId?: string };
      setMessage({ text: "Queued. It lands in the library when it's done.", tone: "success" });
      onQueued(out.groupId);
    } catch (err) {
      setMessage({ text: errorText(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Field label="Speech comes from">
        <Select aria-label="Speech comes from" value={input} onChange={(e) => pickInput(e.target.value as LipsyncInput)}>
          <option value="audio">An audio file</option>
          <option value="line">A line I type</option>
        </Select>
      </Field>
      <Field label="Portrait">
        <Select aria-label="Portrait" value={portraitAssetId} onChange={(e) => setPortrait(e.target.value)}>
          <option value="">Pick an image</option>
          {live("image").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </Field>
      {input === "audio" ? (
        <Field label="Audio">
          <Select aria-label="Audio" value={audioAssetId} onChange={(e) => setAudio(e.target.value)}>
            <option value="">Pick an audio file</option>
            {live("audio").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
      ) : (
        <Field label="Line to say">
          <textarea aria-label="Line to say" rows={3} maxLength={500} value={line} onChange={(e) => setLine(e.target.value)} style={{ width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: 8, borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "inherit" }} />
        </Field>
      )}
      <Field label="Lip-sync model">
        <Select aria-label="Lip-sync model" value={provider} onChange={(e) => setPicked(e.target.value)}>
          {list.map((o) => <option key={o.key} value={o.key}>{optionText(o)}</option>)}
        </Select>
      </Field>
      <p style={muted}>{list.find((o) => o.key === provider)?.qualityNote}</p>
      {warning ? <PageMessage tone="warning" message={warning} /> : null}
      {message ? <PageMessage tone={message.tone} message={message.text} /> : null}
      <Button disabled={busy || !canGenerate || why !== null} onClick={() => void submit()}>Generate lip-sync</Button>
    </div>
  );
}
