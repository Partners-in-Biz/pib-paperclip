/**
 * The Cockpit's check on the site visit counters: a key that has counted nothing after a week was probably never installed. Nothing for a
 * company with no keys. Installing the script is a change to a client's site and needs the owner's OK, so a quiet key is amber, never red.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { listEventKeys, type EventKey } from "./site-events-store.js";

const DAY_MS = 86_400_000;
export const EVENT_KEY_QUIET_DAYS = 7;

export async function eventKeysHealth(ctx: PluginContext, companyId: string, now = Date.now()): Promise<HealthCheck | null> {
  const keys = (await listEventKeys(ctx, companyId)).filter((key) => key.status === "active" && !key.canary);
  if (keys.length === 0) return null;
  const quiet = keys.filter((key) => key.acceptedCount === 0 && key.createdAt && now - Date.parse(key.createdAt) > EVENT_KEY_QUIET_DAYS * DAY_MS);
  if (quiet.length === 0) return { key: "event-keys", title: "Site visit counters", status: "ok", detail: `${keys.length} counter${keys.length === 1 ? "" : "s"} active.` };
  return {
    key: "event-keys",
    title: "Site visit counters",
    status: "warn",
    detail: `${quiet.length} counter${quiet.length === 1 ? "" : "s"} counted nothing in ${EVENT_KEY_QUIET_DAYS} days or more: ${quiet.slice(0, 3).map((key) => key.label).join(", ")}${quiet.length > 3 ? "..." : ""}.`,
    href: "/crm",
    fix: "The snippet is probably not on the site yet. Installing it changes the client's site: it needs the owner's OK and goes through the client's repo project (list-event-keys has each key's snippet).",
    since: quiet.map((key) => key.createdAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
  };
}

/** What is worth telling a person about one key: a key that never counted, and an old key about to stop working. Shared by the tools and the client page. */
export function eventKeyWarnings(key: Pick<EventKey, "status" | "acceptedCount" | "createdAt" | "previousKey" | "previousKeyUntil">, now = new Date()): string[] {
  const warnings: string[] = [];
  if (key.status === "active" && key.acceptedCount === 0 && key.createdAt && now.getTime() - Date.parse(key.createdAt) > 3 * DAY_MS) warnings.push("No event has arrived yet. Is the snippet installed on the site? (Installing it is a change to the client's site: it needs the owner's OK and goes through their repo project.)");
  if (key.previousKey && key.previousKeyUntil && Date.parse(key.previousKeyUntil) > now.getTime()) warnings.push(`The old key stops working on ${key.previousKeyUntil.slice(0, 10)}. Put the new snippet on the site before then.`);
  return warnings;
}
