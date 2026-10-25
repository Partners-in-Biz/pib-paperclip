/**
 * The "plain-words guide" link at the top of a plugin page. `ModuleHelp` (help.tsx) provides the link
 * through this context and `PageFrame` shows the banner as the first line of the page, so a plugin only
 * wraps its page once. Kept apart from help.tsx so `PageFrame` can use it without an import cycle.
 */
import { createContext, useContext, type AnchorHTMLAttributes } from "react";
import { tokens } from "./tokens.js";

export type HelpLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

export interface HelpBannerValue {
  /** Short module name, e.g. "CRM". */
  title: string;
  linkProps: HelpLinkProps;
}

export const HelpBannerContext = createContext<HelpBannerValue | null>(null);

/** What the banner says; exported so tests and docs read the same words. */
export const HELP_BANNER_TEXT = { before: "New to ", after: "? ", link: "Read the plain-words guide" } as const;

export function HelpBanner({ title, linkProps }: HelpBannerValue) {
  return (
    <p
      data-pib-help-banner=""
      style={{ margin: 0, fontSize: 12.5, color: tokens.muted, lineHeight: 1.45, overflowWrap: "anywhere" }}
    >
      {HELP_BANNER_TEXT.before}
      {title}
      {HELP_BANNER_TEXT.after}
      <a {...linkProps} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>
        {HELP_BANNER_TEXT.link}
      </a>
      .
    </p>
  );
}

/** The banner for the surrounding `ModuleHelp`; nothing when the page is not wrapped. */
export function HelpBannerSlot() {
  const value = useContext(HelpBannerContext);
  return value ? <HelpBanner {...value} /> : null;
}
