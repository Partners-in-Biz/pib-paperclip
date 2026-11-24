/**
 * Who may do what in CRM Telephony (access stage A, spec PAR-12578 sections 4.4 and 4.6; PAR-12683). Keys: action
 * key and `tool:<name>`; the plugin has no API routes. Owners and admins always pass; a limited person needs the
 * permission named here. With the company switch `off` (every company today) the guard passes every call on unchanged.
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * - `telephony.calls`: `view` reads calls, timelines, transcripts, recordings and templates; `create` places a call
 *   (the Dialer's token and dial), sends a WhatsApp message, or sets a contact's call preferences (record or not,
 *   language), which shape the calls placed to that contact.
 * - `telephony.settings`: the Telephony settings page (numbers, caps, hours, switches) and the template sync.
 *
 * The plugin's own check (`voiceAllowedUserIds`, src/access.ts) stays as it is, after the guard.
 * The webhooks (Twilio) carry no person and are not guarded. No entry is `scoped`.
 *
 * This file is imported by the page (`ui/actions.ts`), so it takes nothing but types from the kit.
 */
import type { AccessTable, AccessTableEntry, PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const calls = (action: PermissionAction): AccessTableEntry => ({ resource: "telephony.calls", action });
const settings = (action: PermissionAction): AccessTableEntry => ({ resource: "telephony.settings", action });
const rows = (entry: AccessTableEntry, keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, entry]));

export const ACCESS_TABLE: AccessTable = Object.freeze({
  // ── page actions ──
  ...rows(calls("view"), ["voice-call", "telephony.timeline", "telephony.transcript", "telephony.unmatched", "telephony.recording.play"]),
  ...rows(calls("create"), ["voice-token", "voice-dial", "telephony.contact-prefs.set"]),
  "telephony.settings.get": settings("view"),
  ...rows(settings("edit"), ["telephony.settings.save", "telephony.settings.sync-templates"]),

  // ── agent tools: the same permission as the page action that does the same ──
  "tool:telephony-status": settings("view"),
  "tool:whatsapp-templates": calls("view"),
  "tool:whatsapp-sync-templates": settings("edit"),
  "tool:whatsapp-send": calls("create"),
});
