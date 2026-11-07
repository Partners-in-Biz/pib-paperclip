/**
 * "Save to Drive" (PAR-8106): one button that asks the worker to copy the file into the client's Drive `02 Assets`,
 * then shows the Drive link or the refusal in plain words. Each instance owns its own request and state.
 */
import { useState } from "react";
import { Button, errorText, ButtonLink } from "@partnersinbiz/pib-plugin-ui";
import { DRIVE_MAX_BYTES } from "../drive-limits.js";
import { useStudioAction } from "./action.js";
import { awaitTransfer, percent } from "./drive-transfer.js";

export function SaveToDrive({ companyId, assetId, bytes, savedUrl, small }: { companyId: string; assetId: string; bytes?: number; savedUrl?: string | null; small?: boolean }) {
  const save = useStudioAction("drive-save");
  const poll = useStudioAction("drive-transfer");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooLarge = typeof bytes === "number" && bytes > DRIVE_MAX_BYTES;
  const link = url ?? savedUrl ?? null;
  const fontSize = small ? 12 : 13;

  async function run() {
    setBusy(true);
    setError(null);
    setPct(null);
    try {
      // Over 5 MiB the worker answers with a transfer: poll it, showing progress, until the Drive link is there.
      const out = await awaitTransfer<{ url: string }>(await save({ companyId, assetId }), poll, companyId, (done, total) => setPct(percent(done, total)));
      setUrl(out.url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setPct(null);
    }
  }

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
      <Button variant="secondary" disabled={busy || tooLarge} onClick={() => void run()}>
        {busy ? (pct === null ? "Saving…" : `Saving… ${pct}%`) : link ? "Save to Drive again" : "Save to Drive"}
      </Button>
      {busy && pct !== null ? <progress max={100} value={pct} aria-label="Saving to Drive" style={{ width: 96 }} /> : null}
      {tooLarge ? <span style={{ fontSize, color: "var(--muted-foreground)" }}>Too large for Drive (up to {(DRIVE_MAX_BYTES / 1024 / 1024).toFixed(0)} MB, the largest file Studio keeps)</span> : null}
      {link ? (
        <ButtonLink variant="secondary" href={link} target="_blank" rel="noopener noreferrer">
          Open in Drive
        </ButtonLink>
      ) : null}
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize, overflowWrap: "anywhere" }}>{error}</span> : null}
    </span>
  );
}
