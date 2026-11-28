import { and, eq } from "drizzle-orm";
import { pluginCompanySettings, plugins, type Db } from "@paperclipai/db";

/**
 * The company setting `voiceRunProfile` (plan PAR-15073 rev 3, 5.2).
 *
 * It lives as one key in the voice plugin's `plugin_company_settings.settings_json` row for the company:
 * no new column and no migration. Only a board user writes it, through the board-only route in
 * `routes/plugins.ts`. The plugin's own host calls write `localFolders` only and keep this key.
 *
 * Every doubt reads as `off`: no plugin, a plugin that is not ready, the plugin disabled for the company,
 * no row, no key, or a stored value outside the enum. A concurrent `localFolders` write that drops the
 * key therefore lands on the safe side.
 */

/** Manifest id (`plugins.plugin_key`) of the voice plugin, `packages/plugins/plugin-voice/src/namespace.ts`. */
export const VOICE_PLUGIN_KEY = "partnersinbiz.voice";

/** The key in `plugin_company_settings.settings_json`. */
export const VOICE_RUN_PROFILE_SETTING_KEY = "voiceRunProfile";

export const VOICE_RUN_PROFILE_SETTINGS = ["off", "profile", "profile_and_warm"] as const;
export type VoiceRunProfileSetting = (typeof VOICE_RUN_PROFILE_SETTINGS)[number];

/** The value when it is one of the enum, else null. Strict: no trimming, no case folding. */
export function parseVoiceRunProfileSetting(value: unknown): VoiceRunProfileSetting | null {
  return typeof value === "string" && (VOICE_RUN_PROFILE_SETTINGS as readonly string[]).includes(value)
    ? (value as VoiceRunProfileSetting)
    : null;
}

/** The stored value of a settings JSON, or null when the key is absent or invalid. */
export function storedVoiceRunProfileSetting(
  settingsJson: Record<string, unknown> | null | undefined,
): VoiceRunProfileSetting | null {
  if (!settingsJson || typeof settingsJson !== "object") return null;
  return parseVoiceRunProfileSetting(settingsJson[VOICE_RUN_PROFILE_SETTING_KEY]);
}

type ReaderDb = Pick<Db, "select">;

/**
 * The effective setting for one company. Reads the installed-plugin table and the company's own row only,
 * so another company's row never answers for this one.
 */
export async function readVoiceRunProfileSetting(db: ReaderDb, companyId: string): Promise<VoiceRunProfileSetting> {
  const rows = await db
    .select({
      status: plugins.status,
      enabled: pluginCompanySettings.enabled,
      settingsJson: pluginCompanySettings.settingsJson,
    })
    .from(plugins)
    .leftJoin(pluginCompanySettings, and(
      eq(pluginCompanySettings.pluginId, plugins.id),
      eq(pluginCompanySettings.companyId, companyId),
    ))
    .where(eq(plugins.pluginKey, VOICE_PLUGIN_KEY));
  const row = rows[0];
  if (!row || row.status !== "ready" || row.enabled !== true) return "off";
  return storedVoiceRunProfileSetting(row.settingsJson) ?? "off";
}
