/**
 * The whole-plugin page gate for Studio (access stage A, spec PAR-12578 section 4.6, PAR-12688). Each page and the
 * sidebar entry asks `access.me` first: closed shows the kit's "no access" page (nothing for the sidebar). The gate
 * only shapes the screen; the worker's guard refuses every call anyway, and the gate stays open on an error or timeout.
 */
import type { ComponentType } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { AccessGate, useAccess } from "@partnersinbiz/pib-plugin-ui";
import { useAccessMe } from "./action.js";

export function withStudioAccess<P extends PluginPageProps>(Inner: ComponentType<P>, kind: "page" | "sidebar"): ComponentType<P> {
  function StudioAccess(props: P) {
    const host = useHostContext();
    const access = useAccess(useAccessMe(), props.context?.companyId ?? host.companyId ?? null);
    return (
      <AccessGate state={access} kind={kind} moduleName="Studio">
        <Inner {...props} />
      </AccessGate>
    );
  }
  StudioAccess.displayName = `StudioAccess(${Inner.displayName ?? Inner.name ?? "Page"})`;
  return StudioAccess;
}
