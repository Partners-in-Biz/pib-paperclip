import type { SaveResult } from "./transcript-report.js";

export function failureMessage(result: SaveResult): string {
  const parts: string[] = [];
  if (result.failed.length > 0) {
    parts.push(`The call transcript was not saved on ${result.failed.map((f) => f.ref).join(", ")} (${result.failed[0]!.error}).`);
  }
  if (result.skipped > 0) parts.push(`${result.skipped} more task${result.skipped === 1 ? "" : "s"} touched by the call got no transcript.`);
  return parts.join(" ");
}

/** A plain-DOM notice that outlives the call panel, with a retry that keeps the transcript in memory. */
export function showSaveNotice(message: string, retry: (() => Promise<void>) | null): void {
  document.getElementById("pib-voice-save-notice")?.remove();
  const box = document.createElement("div");
  box.id = "pib-voice-save-notice";
  box.setAttribute("role", "alert");
  box.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:360px;padding:12px 14px;border-radius:10px;" +
    "background:#1f1f1f;color:#fff;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)";
  const text = document.createElement("div");
  text.textContent = message;
  box.append(text);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;margin-top:8px";
  const button = (label: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "padding:4px 10px;border-radius:6px;border:1px solid #888;background:transparent;color:#fff;cursor:pointer";
    b.addEventListener("click", onClick);
    return b;
  };
  if (retry) {
    const retryButton = button("Try again", () => {
      retryButton.disabled = true;
      void retry().catch(() => undefined).finally(() => box.remove());
    });
    row.append(retryButton);
  }
  row.append(button("Dismiss", () => box.remove()));
  box.append(row);
  document.body.append(box);
}
