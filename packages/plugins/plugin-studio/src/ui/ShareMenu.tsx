/**
 * Share a board read-only (PAR-8093): editors make a link, copy it and revoke it. The link is a static page the worker
 * writes into this bundle's own folder (`s/<id>.html`), so the full URL is built from where this bundle is served.
 * Only editors get this menu: the list comes from an editor-only action because each entry carries the secret path.
 */
import { useCallback, useEffect, useState } from "react";
import { Button, errorText } from "@partnersinbiz/pib-plugin-ui";
import { useStudioAction } from "./action.js";

interface Share {
  id: string;
  path: string;
  expiresAt: string | null;
}

export function shareUrl(path: string, base: string = import.meta.url): string {
  return new URL(path, base).href;
}

/** Open state can come from the page, so opening this menu closes the Versions one (PAR-8102). */
export function ShareMenu({ companyId, canvasId, open: shown, onOpenChange }: { companyId: string; canvasId: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [list, setList] = useState<Share[] | null>(null);
  const load = useStudioAction("canvas-share-list");
  const create = useStudioAction("canvas-share-create");
  const revoke = useStudioAction("canvas-share-revoke");

  const refresh = useCallback(async () => {
    const out = (await load({ companyId, canvasId })) as { shares?: Share[] } | null;
    setList(out?.shares ?? []);
  }, [load, companyId, canvasId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(errorText(error)));
  }, [open, refresh]);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await refresh();
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

  const shares = list ?? [];
  return (
    <div style={{ position: "relative" }}>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Share{shares.length ? ` (${shares.length})` : ""}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="Share this canvas"
          style={{ position: "absolute", zIndex: 20, top: "calc(100% + 4px)", right: 0, width: "min(22rem, calc(100vw - 16px))", maxHeight: "70vh", overflowY: "auto", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "var(--popover, var(--background, #fff))", border: "1px solid var(--border, #ddd)", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.15)" }}
        >
          <span style={{ fontSize: 13, opacity: 0.8 }}>Anyone with a link sees this board and its previews, without editing. Links last 7 days.</span>
          <Button disabled={busy} onClick={() => void run(() => create({ companyId, canvasId }), "Link made. Copy it below.")}>
            {busy ? "Working…" : "Make a view-only link"}
          </Button>
          {list === null && !message ? <span style={{ fontSize: 13 }}>Loading links…</span> : null}
          {list !== null && shares.length === 0 ? <span style={{ fontSize: 13 }}>No live links.</span> : null}
          {shares.map((share) => (
            <div key={share.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 8rem", minWidth: 0, fontSize: 13, overflowWrap: "anywhere" }}>
                Expires {share.expiresAt ? new Date(share.expiresAt).toLocaleDateString() : "—"}
              </span>
              <Button variant="secondary" onClick={() => void copy(shareUrl(share.path))}>Copy link</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void run(() => revoke({ companyId, shareId: share.id }), "Link revoked. It no longer opens.")}>
                Revoke
              </Button>
            </div>
          ))}
          {message ? <span role="status" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{message}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
