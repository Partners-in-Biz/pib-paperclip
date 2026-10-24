import { PreferencesPanel, type PreferencesLoadResult, type PreferencesSaveResult } from "@partnersinbiz/pib-plugin-ui";
import { BANK_PREFERENCE_IDS } from "../preference-ids.js";
import { Card, useBilling } from "./parts.js";

/** Overview → Preferences: the choices a company owner or admin sets without an instance admin. The server decides who may save. */
export function PreferencesSection() {
  const { call } = useBilling();
  return (
    <Card title="Preferences">
      <PreferencesPanel
        load={() => call<PreferencesLoadResult>("billing.preferences-load")}
        // The panel asks the owner to confirm a bank-detail change before it calls save, so a save is a confirmed one.
        save={(patch) => call<PreferencesSaveResult>("billing.preferences-save", { patch, confirmed: true })}
        confirmChange={BANK_PREFERENCE_IDS}
      />
    </Card>
  );
}
