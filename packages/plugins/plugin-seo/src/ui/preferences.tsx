/** The Preferences section of the SEO home: the choices a company owner or admin changes without an instance admin. */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { PreferencesPanel, SectionCard, type PreferencesLoadResult, type PreferencesSaveResult, type PreferenceValues } from "@partnersinbiz/pib-plugin-ui";

export function SeoPreferences() {
  const loadAction = usePluginAction("seo.preferences-load");
  const saveAction = usePluginAction("seo.preferences-save");
  return (
    <SectionCard title="Preferences" subtitle="Timezone, the daily run hour and the default autopilot for new sprints.">
      <PreferencesPanel
        load={() => loadAction({}) as Promise<PreferencesLoadResult>}
        save={(patch: PreferenceValues) => saveAction({ patch }) as Promise<PreferencesSaveResult>}
      />
    </SectionCard>
  );
}
