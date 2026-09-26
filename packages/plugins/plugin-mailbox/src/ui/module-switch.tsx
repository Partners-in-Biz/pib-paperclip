import { useEffect, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { moduleEnabled } from "@partnersinbiz/pib-plugin-kit/setup-client";
import { tokens } from "@partnersinbiz/pib-plugin-ui";

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

/** Small notice at the top of the page when the module is switched off. */
export function ModuleOffBanner({ companyId, pluginKey }: { companyId: string | null | undefined; pluginKey: string }) {
  const enabled = useModuleEnabled(companyId, pluginKey);
  const navigation = useHostNavigation();
  if (enabled !== false) return null;
  return (
    <p
      role="status"
      style={{
        margin: 0,
        fontSize: 13,
        padding: "10px 14px",
        borderRadius: 10,
        border: `1px solid ${tokens.border}`,
        background: tokens.secondary,
        color: tokens.secondaryFg,
        lineHeight: 1.45,
      }}
    >
      This module is switched off for this company. Turn it on in{" "}
      <a {...navigation.linkProps("/setup")} style={{ color: "inherit", textDecoration: "underline" }}>Setup</a>.
    </p>
  );
}
