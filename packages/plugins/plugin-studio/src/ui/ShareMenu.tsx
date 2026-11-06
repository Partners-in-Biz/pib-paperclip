/**
 * Share a board read-only (PAR-8093): editors make a link, copy it and revoke it. The link is a static page the worker
 * writes into this bundle's own folder (`s/<id>.html`), so the full URL is built from where this bundle is served.
 */
import { useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";

interface Share {
  id: string;
  path: string;
  expiresAt: string | null;
}

export function shareUrl(path: string, base: string = import.meta.url): string {
  return new URL(path, base).href;
}

export function ShareMenu({ companyId, canvasId, canEdit }: { companyId: string; canvasId: string; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const shares = usePluginData<{ shares: Share[] }>("canvas-shares", { companyId, canvasId });
  const create = usePluginAction("canvas-share-create");
  const revoke = usePluginAction("canvas-share-revoke");
  const list = shares.data?.shares ?? [];

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      shares.refresh();
      setMessage(done);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Link copied.");
    } catch {
      setMessage(url);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Share{list.length ? ` (${list.length})` : ""}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Share this canvas"
          style={{ position: "absolute", zIndex: 20, top: "calc(100% + 4px)", right: 0, width: "min(22rem, 90vw)", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "var(--popover, var(--background, #fff))", border: "1px solid var(--border, #ddd)", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.15)" }}
        >
          <span style={{ fontSize: 13, opacity: 0.8 }}>Anyone with a link sees this board and its previews, without editing. Links last 7 days.</span>
          {canEdit ? (
            <Button disabled={busy} onClick={() => void run(() => create({ companyId, canvasId }), "Link made. Copy it below.")}>
              {busy ? "Working…" : "Make a view-only link"}
            </Button>
          ) : null}
          {list.length === 0 ? <span style={{ fontSize: 13 }}>No live links.</span> : null}
          {list.map((share) => (
            <div key={share.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 8rem", minWidth: 0, fontSize: 13 }}>
                Expires {share.expiresAt ? new Date(share.expiresAt).toLocaleDateString() : "—"}
              </span>
              <Button variant="secondary" onClick={() => void copy(shareUrl(share.path))}>Copy link</Button>
              {canEdit ? (
                <Button variant="secondary" disabled={busy} onClick={() => void run(() => revoke({ companyId, shareId: share.id }), "Link revoked. It no longer opens.")}>
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
          {message ? <span role="status" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{message}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
