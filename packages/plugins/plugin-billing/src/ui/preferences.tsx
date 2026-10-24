import { PreferencesPanel, type PreferencesLoadResult, type PreferencesSaveResult } from "@partnersinbiz/pib-plugin-ui";
import { Card, useBilling } from "./parts.js";

/** Overview → Preferences: the choices a company owner or admin sets without an instance admin. The server decides who may save. */
export function PreferencesSection() {
  const { call } = useBilling();
  return (
    <Card title="Preferences">
      <PreferencesPanel
        load={() => call<PreferencesLoadResult>("billing.preferences-load")}
        save={(patch) => call<PreferencesSaveResult>("billing.preferences-save", { patch })}
      />
    </Card>
  );
}
