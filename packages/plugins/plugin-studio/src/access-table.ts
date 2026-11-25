/**
 * Studio's access table (PAR-12578 plan 4.4, ticket PAR-12687): which permission each page action and agent tool
 * needs when a company's access switch is `report` or `enforce`. With the switch `off` (every company today) the
 * guard passes every call on unchanged.
 *
 * The rows only add a gate in front of the handlers; the handlers keep their own role checks (viewers look only,
 * caps and the balance are owner-only, an agent limit is owner or admin). `studio.work` is not scopable, so no row is
 * `scoped`. The 9 data handlers carry no caller and are not in this table (plan 4.4, S13).
 *
 * Rule of thumb: reading is `view`; making a new asset, board, edit or task is `create`; changing one is `edit`;
 * archiving or deleting is `delete`; anything that leaves Studio (Drive save, read-only share links) is `export`.
 */
import { ANY_MEMBER, type AccessTable, type AccessTableEntry, type PermissionEntry } from "@partnersinbiz/pib-plugin-kit";

const work = (action: PermissionEntry["action"]): PermissionEntry => ({ resource: "studio.work", action });
const VIEW = work("view");
const CREATE = work("create");
const EDIT = work("edit");
const DELETE = work("delete");
const EXPORT = work("export");
const SETTINGS_EDIT: PermissionEntry = { resource: "studio.settings", action: "edit" };

const rows = (entry: AccessTableEntry, keys: string[]) => Object.fromEntries(keys.map((key) => [key, entry]));

export const STUDIO_ACCESS_TABLE: AccessTable = Object.freeze({
  // The caller's own role, which the page reads first to lay itself out; it names no record.
  me: ANY_MEMBER("returns only the caller's own role, which every Studio page reads to lay itself out"),

  // Credit caps, the Higgsfield balance and agent limits. The handlers still allow only an owner (or an admin for an agent limit).
  ...rows(SETTINGS_EDIT, ["set-cap", "set-balance", "set-agent-limit"]),

  // Page actions.
  ...rows(VIEW, [
    "asset-url", "asset-urls", "asset-data", "board-library", "brand-kit", "drive-list", "drive-thumbs", "drive-transfer",
    "prompt-templates", "canvas-templates", "canvas-text-drafts",
    "video-edit-list", "video-edit-get", "video-edit-render-status", "video-edit-versions-list", "video-edit-detect-beats",
  ]),
  ...rows(CREATE, [
    "estimate", "generate", "studio-lipsync", "drive-import", "layout-save", "give-prepare", "give-record", "give-discard",
    "canvas-create", "video-edit-create", "video-edit-render",
  ]),
  ...rows(EDIT, [
    "review", "save-prompt-template", "save-canvas-template", "canvas-text-draft-taken", "canvas-save",
    "canvas-version-save", "canvas-version-restore", "canvas-comment-add",
    "video-edit-apply-ops", "video-edit-caption", "video-edit-cut-to-beat", "video-edit-cut-silences", "video-edit-voiceover",
    "video-edit-music", "video-edit-cancel-render", "video-edit-version-save", "video-edit-restore",
  ]),
  ...rows(DELETE, ["delete-prompt-template", "delete-canvas-template", "canvas-archive", "video-edit-delete"]),
  // Saving to Drive and read-only share links take work out of Studio; the share list carries the secret link paths.
  ...rows(EXPORT, ["drive-save", "canvas-share-list", "canvas-share-create", "canvas-share-revoke"]),

  // Agent tools: the person the run works for needs the same permission as the matching page action.
  ...rows(VIEW, [
    "tool:studio-usage", "tool:studio-generation-status", "tool:studio-list-assets", "tool:studio-get-asset",
    "tool:studio-drive-transfer", "tool:studio-brand-kit",
    "tool:video-edit-get", "tool:video-edit-list", "tool:video-edit-detect-beats", "tool:video-edit-render-status",
  ]),
  ...rows(CREATE, [
    "tool:studio-estimate", "tool:studio-generate", "tool:studio-lipsync", "tool:studio-import-from-attachment", "tool:canvas-create-from-brief",
    "tool:video-edit-create", "tool:video-edit-render",
  ]),
  ...rows(EDIT, [
    "tool:studio-review-asset", "tool:studio-link-asset", "tool:canvas-write-text",
    "tool:video-edit-apply-ops", "tool:video-edit-caption", "tool:video-edit-voiceover", "tool:video-edit-music",
    "tool:video-edit-cut-to-beat", "tool:video-edit-cut-silences", "tool:video-edit-cancel-render",
  ]),
  ...rows(DELETE, ["tool:video-edit-delete"]),
  ...rows(EXPORT, ["tool:studio-drive-save"]),
});
