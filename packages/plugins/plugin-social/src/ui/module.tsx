/**
 * Module switch from the Setup plugin. `null` while loading (render normally),
 * `false` when the company switched Social off or it is not in its plan.
 */
import { useEffect, useState } from "react";
import { moduleEnabled, moduleState } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { ModuleStateBanner } from "@partnersinbiz/pib-plugin-ui";
import { PLUGIN_ID } from "../platforms.js";

export function useModuleEnabled(companyId: string | null | undefined): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, PLUGIN_ID)
      .then((value) => {
        if (live) setEnabled(value);
      })
      .catch(() => {
        if (live) setEnabled(true);
      });
    return () => {
      live = false;
    };
  }, [companyId]);
  return enabled;
}

/** The page banner for a module that is off or not in the plan; the words live in `pib-plugin-ui`. */
export function ModuleOffBanner({ companyId }: { companyId: string | null | undefined }) {
  const navigation = useHostNavigation();
  return <ModuleStateBanner companyId={companyId} pluginKey={PLUGIN_ID} load={moduleState} setupLinkProps={navigation.linkProps("/setup")} />;
}
