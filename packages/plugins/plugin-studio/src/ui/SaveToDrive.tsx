/**
 * "Save to Drive" (PAR-8106): one button that asks the worker to copy the file into the client's Drive `02 Assets`,
 * then shows the Drive link or the refusal in plain words. Each instance owns its own request and state.
 */
import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { DRIVE_MAX_BYTES } from "../drive-limits.js";

export function SaveToDrive({ companyId, assetId, bytes, savedUrl, small }: { companyId: string; assetId: string; bytes?: number; savedUrl?: string | null; small?: boolean }) {
  const save = usePluginAction("drive-save");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooLarge = typeof bytes === "number" && bytes > DRIVE_MAX_BYTES;
  const link = url ?? savedUrl ?? null;
  const fontSize = small ? 12 : 13;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const out = (await save({ companyId, assetId })) as { url: string };
      setUrl(out.url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
      <Button variant="secondary" disabled={busy || tooLarge} onClick={() => void run()}>
        {busy ? "Saving…" : link ? "Save to Drive again" : "Save to Drive"}
      </Button>
      {tooLarge ? <span style={{ fontSize, color: "var(--muted-foreground)" }}>Too large for Drive (up to 5 MB for now)</span> : null}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontSize, overflowWrap: "anywhere" }}>
          Open in Drive
        </a>
      ) : null}
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize, overflowWrap: "anywhere" }}>{error}</span> : null}
    </span>
  );
}
