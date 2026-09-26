/**
 * Script for the static OAuth callback page. Bundled to
 * `dist/ui/oauth-callback.js` in each plugin that connects external accounts.
 *
 * Flow: provider → /_plugins/<id>/ui/oauth-callback.html?code&state →
 * POST {companyId, state, params} to the plugin's completion route with the
 * board session → follow `redirectTo`.
 */
import { forgetOAuthStart, readOAuthStart } from "./client.js";

function setStatus(title: string, detail: string, tone: "work" | "ok" | "error", backHref?: string) {
  const titleEl = document.getElementById("title");
  const detailEl = document.getElementById("detail");
  const backEl = document.getElementById("back") as HTMLAnchorElement | null;
  const root = document.getElementById("card");
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (root) root.setAttribute("data-tone", tone);
  if (backEl) {
    if (backHref) {
      backEl.href = backHref;
      backEl.hidden = false;
    } else {
      backEl.hidden = true;
    }
  }
}

async function run() {
  const params = new URLSearchParams(window.location.search);
  const entries: Record<string, string> = {};
  params.forEach((value, key) => {
    entries[key] = value;
  });
  // Keep the authorization code out of history and the Referer of later requests.
  window.history.replaceState(null, "", window.location.pathname);

  const state = entries.state ?? entries.pstate ?? "";
  if (!state) {
    setStatus("Connection could not finish", "The provider did not return a state value. Start the connection again from Paperclip.", "error", "/");
    return;
  }
  const pending = readOAuthStart(state);
  if (!pending) {
    setStatus(
      "Connection could not finish",
      "This sign-in was started in another browser or has expired. Go back to Paperclip and click Connect again.",
      "error",
      "/",
    );
    return;
  }
  if (entries.error) {
    forgetOAuthStart(state);
    setStatus(
      "Access was not granted",
      entries.error_description || entries.error_message || entries.error,
      "error",
      pending.returnTo,
    );
    return;
  }

  setStatus(`Connecting ${pending.label ?? "account"}…`, "Finishing the sign-in with Paperclip.", "work");
  try {
    const res = await fetch(pending.completeUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ companyId: pending.companyId, state, params: entries }),
    });
    const text = await res.text();
    let body: { redirectTo?: string; error?: string } = {};
    try {
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      body = { error: text.slice(0, 300) };
    }
    forgetOAuthStart(state);
    if (!res.ok || body.error) {
      setStatus("Connection failed", body.error ?? `HTTP ${res.status}`, "error", pending.returnTo);
      return;
    }
    setStatus("Connected", "Taking you back to Paperclip…", "ok");
    window.location.replace(body.redirectTo || pending.returnTo || "/");
  } catch (error) {
    setStatus("Connection failed", error instanceof Error ? error.message : String(error), "error", pending.returnTo);
  }
}

void run();
