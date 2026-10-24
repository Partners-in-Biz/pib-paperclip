import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { PreferencesPanel, type PreferenceValues, type PreferencesLoadResult, type PreferencesSaveResult } from "@partnersinbiz/pib-plugin-ui";

/** Company preferences (time zone, agent replies, own-work name). The server refuses anyone who is not an owner or admin. */
export function PreferencesSection() {
  const load = usePluginAction("social.preferences-load");
  const save = usePluginAction("social.preferences-save");
  return (
    <details style={{ marginTop: 16 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Preferences</summary>
      <div style={{ marginTop: 10 }}>
        <PreferencesPanel
          load={async () => (await load({})) as PreferencesLoadResult}
          save={async (patch: PreferenceValues) => (await save({ patch })) as PreferencesSaveResult}
        />
      </div>
    </details>
  );
}
