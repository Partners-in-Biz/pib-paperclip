/**
 * Module switch from the Setup plugin. `null` while loading (render normally),
 * `false` only when the company switched SEO off.
 */
import { useEffect, useState } from "react";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { EmptyState, tokens } from "@partnersinbiz/pib-plugin-ui";

// Literal: namespace.ts imports node:crypto, which the browser bundle must not pull in.
const PLUGIN_ID = "partnersinbiz.seo";

export const MODULE_OFF_TEXT = "This module is switched off for this company. Turn it on in Setup.";

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

export function ModuleOffBanner() {
  const navigation = useHostNavigation();
  return (
    <EmptyState
      title="SEO is switched off"
      description={MODULE_OFF_TEXT}
      action={<a {...navigation.linkProps("/setup")} style={{ fontSize: 13, color: tokens.fg }}>Open Setup</a>}
    />
  );
}
