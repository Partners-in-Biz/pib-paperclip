/**
 * The page banner for a module that is not on, one copy for every plugin. The state comes from the
 * kit (`moduleState` in `@partnersinbiz/pib-plugin-kit/setup-client`); this package has no kit or SDK
 * dependency, so the plugin passes that function and the Setup link in.
 */
import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { tokens } from "./tokens.js";

export type ModuleState = "on" | "off" | "not_entitled";
export type ModuleStateLoader = (companyId: string | null | undefined, pluginKey: string) => Promise<ModuleState>;

/** Null while loading; `on` when the loader fails (a page never locks itself because Setup is unreachable). */
export function useModuleState(companyId: string | null | undefined, pluginKey: string, load: ModuleStateLoader): ModuleState | null {
  const [state, setState] = useState<ModuleState | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    load(companyId, pluginKey)
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setState("on");
      });
    return () => {
      live = false;
    };
  }, [companyId, pluginKey, load]);
  return state;
}

/** What the banner says for a state that is not `on`. Exported so tests and docs read the same words. */
export const MODULE_STATE_TEXT = {
  off: { before: "This module is switched off for this company. Turn it on in ", link: "Setup", after: "." },
  not_entitled: { before: "This module is not in your plan. Ask Partners in Biz to add it.", link: "", after: "" },
} as const;

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/** The words for a module that is not on; nothing for `on` or while loading. */
export function ModuleStateNotice({ state, setupLinkProps }: { state: ModuleState | null; setupLinkProps: LinkProps }) {
  if (state === null || state === "on") return null;
  const text = MODULE_STATE_TEXT[state];
  return (
    <p
      role="status"
      data-module-state={state}
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
      {text.before}
      {text.link ? <a {...setupLinkProps} style={{ color: "inherit", textDecoration: "underline" }}>{text.link}</a> : null}
      {text.after}
    </p>
  );
}

/** Loads the state and shows the notice: the Setup banner when the module is off, the plan banner when it is not in the plan. */
export function ModuleStateBanner({
  companyId,
  pluginKey,
  load,
  setupLinkProps,
}: {
  companyId: string | null | undefined;
  pluginKey: string;
  load: ModuleStateLoader;
  setupLinkProps: LinkProps;
}) {
  return <ModuleStateNotice state={useModuleState(companyId, pluginKey, load)} setupLinkProps={setupLinkProps} />;
}
