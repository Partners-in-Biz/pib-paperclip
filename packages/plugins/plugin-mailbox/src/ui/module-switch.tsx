import { useEffect, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { moduleEnabled, moduleState } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { ModuleStateBanner } from "@partnersinbiz/pib-plugin-ui";

/** Null while loading; false only when the company switched the module off in Setup. */
export function useModuleEnabled(companyId: string | null | undefined, pluginKey: string): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setEnabled(null);
    moduleEnabled(companyId, pluginKey)
      .then((value) => {
        if (live) setEnabled(value);
      })
      .catch(() => {
        if (live) setEnabled(true);
      });
    return () => {
      live = false;
    };
  }, [companyId, pluginKey]);
  return enabled;
}

/** The page banner for a module that is off or not in the plan; the words live in `pib-plugin-ui`. */
export function ModuleOffBanner({ companyId, pluginKey }: { companyId: string | null | undefined; pluginKey: string }) {
  const navigation = useHostNavigation();
  return <ModuleStateBanner companyId={companyId} pluginKey={pluginKey} load={moduleState} setupLinkProps={navigation.linkProps("/setup")} />;
}
