/**
 * Who may do what in Voice (access stage A, spec PAR-12578 sections 4.4 and 4.7; PAR-12678).
 * Keys: action key, `tool:<name>`, `api:<routeKey>`. Owners and admins always pass; a limited person
 * needs the permission named here. With the company switch `off` (the default) nothing is checked.
 *
 * - `voice.use`: a voice note (`transcribe`), a live call (`live-session`) and a spoken reply (`speak`). All
 *   spend provider credit, so all are `create`. No preset holds `voice.use` (S7): a limited person has it only when an owner
 *   switches it on for him in Setup, under People.
 * - `voice.settings`: the voice an agent speaks with in a live call.
 *
 * Voice has no tools and no API routes. Its two data handlers (`status`, `agent-voice`) carry no caller
 * and stay as they are in stage A (spec 4.4, S13). No entry is `scoped`: Voice holds no client records.
 */
import type { AccessTable, PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

const use = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "voice.use", action });
const settings = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "voice.settings", action });

export const ACCESS_TABLE: AccessTable = Object.freeze({
  transcribe: use("create"),
  "live-session": use("create"),
  speak: use("create"),
  "set-agent-voice": settings("edit"),
});
