/**
 * The plain-words help page for a module and the wrapper that adds it to a plugin page.
 *
 * A plugin wraps its page once: `<ModuleHelp pluginKey search linkProps>…page…</ModuleHelp>`. The page then
 * shows a guide link in its banner, and `?help=1` shows the guide instead of the page. This package has no
 * SDK dependency, so the plugin passes the host's location search and `linkProps`.
 */
import type { ReactNode } from "react";
import { PageFrame, PageHeader } from "./index.js";
import { HelpBannerContext, type HelpLinkProps } from "./help-banner.js";
import { fillHelp, helpBackTo, helpPageFor, helpTo, isHelpRequested, type HelpPageContent, type HelpVars } from "./help-content.js";
import { tokens } from "./tokens.js";

type LinkPropsFn = (to: string) => HelpLinkProps;

function HelpSection({ title, items, vars }: { title: string; items: readonly string[]; vars: HelpVars }) {
  return (
    <section
      style={{ border: `1px solid ${tokens.border}`, borderRadius: 12, padding: "16px 18px", display: "grid", gap: 10, minWidth: 0 }}
    >
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>{title}</h2>
      <ul style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6, fontSize: 13.5, lineHeight: 1.55, overflowWrap: "anywhere" }}>
        {items.map((item) => (
          <li key={item}>{fillHelp(item, vars)}</li>
        ))}
      </ul>
    </section>
  );
}

/** The guide itself: what the module does, what the agents do, what the owner does. */
export function HelpView({ page, backLinkProps, vars = {} }: { page: HelpPageContent; backLinkProps: HelpLinkProps; vars?: HelpVars }) {
  return (
    <PageFrame accent={page.pluginKey}>
      <a {...backLinkProps} style={{ fontSize: 12.5, color: tokens.muted, textDecoration: "none", width: "fit-content" }}>
        ← Back to {page.title}
      </a>
      <PageHeader title={`How ${page.title} works`} description={fillHelp(page.intro, vars)} accent={page.pluginKey} />
      <HelpSection title="What it does" items={page.does} vars={vars} />
      <HelpSection title="What the agents do" items={page.agents} vars={vars} />
      <HelpSection title="What you do" items={page.owner} vars={vars} />
    </PageFrame>
  );
}

/** Wrap a plugin page: adds the guide link to its banner and shows the guide when the address has `?help=1`. */
export function ModuleHelp({ pluginKey, search, linkProps, vars, children }: {
  pluginKey: string;
  /** The host location's search string. */
  search: string | null | undefined;
  /** The host's `useHostNavigation().linkProps`. */
  linkProps: LinkPropsFn;
  vars?: HelpVars;
  children: ReactNode;
}) {
  const page = helpPageFor(pluginKey);
  if (!page) return <>{children}</>;
  if (isHelpRequested(search)) return <HelpView page={page} backLinkProps={linkProps(helpBackTo(page, search))} vars={vars} />;
  return <HelpBannerContext.Provider value={{ title: page.title, linkProps: linkProps(helpTo(page, search)) }}>{children}</HelpBannerContext.Provider>;
}
