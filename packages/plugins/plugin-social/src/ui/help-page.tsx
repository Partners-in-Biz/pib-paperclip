import type { ComponentType } from "react";
import { useHostLocation, useHostNavigation, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { ModuleHelp } from "@partnersinbiz/pib-plugin-ui";

const PLUGIN_KEY = "partnersinbiz.social";

/** Adds the plain-words guide to this plugin's page: a link in the banner, and the guide itself at `?help=1`. */
export function withHelp(Page: ComponentType<PluginPageProps>): ComponentType<PluginPageProps> {
  return function PageWithHelp(props: PluginPageProps) {
    const location = useHostLocation();
    const navigation = useHostNavigation();
    return (
      <ModuleHelp pluginKey={PLUGIN_KEY} search={location.search} linkProps={navigation.linkProps}>
        <Page {...props} />
      </ModuleHelp>
    );
  };
}
