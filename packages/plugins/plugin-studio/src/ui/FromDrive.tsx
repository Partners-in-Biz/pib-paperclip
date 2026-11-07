/**
 * "From Drive" (PAR-8107): lists the picked client's Drive assets and copies the chosen one into Studio.
 * Each instance owns its own requests and state; nothing about Drive is kept after it closes.
 */
import { useState } from "react";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  tooLarge: boolean;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** `client` is the scope the files are for: "company:<id>", "contact:<id>" or "own". Empty: no client picked yet. */
export function FromDrive({ companyId, client, onImported, small }: { companyId: string; client: string; onImported: (asset: { id: string; name: string }) => void; small?: boolean }) {
  const list = useStudioAction("drive-list");
  const importFile = useStudioAction("drive-import");
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fontSize = small ? 12 : 13;

  async function load() {
    setOpen(true);
    setFiles(null);
    setError(null);
    setBusy("list");
    try {
      setFiles(((await list({ companyId, client })) as { files: DriveFile[] }).files);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function pick(f: DriveFile) {
    setBusy(f.id);
    setError(null);
    try {
      const asset = (await importFile({ companyId, client, fileId: f.id })) as { id: string; name: string };
      setOpen(false);
      onImported(asset);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (!client) return <span style={{ fontSize, color: "var(--muted-foreground)" }}>Pick a client to add files from Drive.</span>;
  return (
    <div className="nodrag" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
        <Button variant="secondary" disabled={busy !== null} onClick={() => (open ? setOpen(false) : void load())}>
          {busy === "list" ? "Loading Drive…" : open ? "Close Drive" : "From Drive"}
        </Button>
      </span>
      {open && files ? (
        files.length === 0 ? (
          <span style={{ fontSize, color: "var(--muted-foreground)" }}>No images or videos in this client's Drive assets.</span>
        ) : (
          <ul aria-label="Drive files" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4, maxHeight: 240, overflowY: "auto", minWidth: 0 }}>
            {files.map((f) => (
              <li key={f.id} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>
                  {f.name}
                </span>
                <span style={{ color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>{f.tooLarge ? "Too large" : size(f.size)}</span>
                <Button variant="secondary" disabled={busy !== null || f.tooLarge} onClick={() => void pick(f)}>
                  {busy === f.id ? "Adding…" : "Add"}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {error ? <span role="alert" style={{ color: "var(--destructive)", fontSize, overflowWrap: "anywhere" }}>{error}</span> : null}
    </div>
  );
}
