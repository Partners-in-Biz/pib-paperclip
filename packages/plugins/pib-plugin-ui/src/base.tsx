/**
 * Shared base: media-query hooks, layout helpers and the injected base styles
 * (layout rules for `.pib-ui`, the colour tokens, and a few component rules
 * that inline styles cannot express: hover, keyframes, reduced motion).
 */
import { useInsertionEffect, useSyncExternalStore, type CSSProperties } from "react";
import { THEME_CSS } from "./tokens.js";

export const font = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Phones (and very narrow windows). Pages, dialogs and sheets switch layout below this width. */
export const NARROW_QUERY = "(max-width: 640px)";

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
    const list = window.matchMedia(query);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  };
}

export function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

const mediaSubscribers = new Map<string, (onChange: () => void) => () => void>();

/** True while `query` matches (default: a phone-sized viewport). False where `matchMedia` is missing (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  let subscribe = mediaSubscribers.get(query);
  if (!subscribe) {
    subscribe = subscribeMedia(query);
    mediaSubscribers.set(query, subscribe);
  }
  return useSyncExternalStore(subscribe, () => mediaMatches(query), () => false);
}

/** True on a phone-sized viewport (`max-width: 640px`). */
export function useIsNarrow(): boolean {
  return useMediaQuery(NARROW_QUERY);
}

/** For URLs, ids, keys, email addresses and other long strings without spaces. */
export const breakAnywhere: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word" };

/** Grid template for one column that may shrink below its content (a plain `display: grid` column never does). */
export const oneColumn = "minmax(0, 1fr)";

/** `repeat(auto-fill|auto-fit, minmax(<min>, 1fr))` that never forces a column wider than its container. */
export function fluidColumns(min: number, mode: "auto-fill" | "auto-fit" = "auto-fit"): string {
  return `repeat(${mode}, minmax(min(${min}px, 100%), 1fr))`;
}

/**
 * Versioned so a page that also runs an older plugin bundle (which injected
 * `pib-plugin-ui-base` without the colour tokens) still gets them.
 */
const STYLE_ID = "pib-plugin-ui-base-v2";
const TEXT_INPUTS = "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color])";

/**
 * Base rules for everything inside `.pib-ui` (pages, dialogs, sheets). `:where()` keeps them at zero
 * specificity, so any inline style still wins. They stop wide content from stretching the page on a
 * phone: boxes may shrink below their content, long words wrap, media and fields never exceed their box.
 */
export const BASE_CSS = `
${THEME_CSS}
.pib-ui{min-width:0;max-width:100%;overflow-wrap:break-word;-webkit-text-size-adjust:100%;text-size-adjust:100%}
.pib-ui,.pib-ui *,.pib-ui *::before,.pib-ui *::after{box-sizing:border-box}
.pib-ui :where(div,section,article,aside,header,footer,main,nav,form,fieldset,label,ul,ol,li,dl,dt,dd,p,h1,h2,h3,h4,h5,h6,span,strong,em,small,a,code,figure,blockquote,details,summary){min-width:0}
.pib-ui :where(img,video,canvas,iframe,svg){max-width:100%}
.pib-ui :where(input,select,textarea){max-width:100%}
.pib-ui :where(pre){max-width:100%;overflow-x:auto}
.pib-ui :where(table){border-collapse:collapse}
.pib-scroll-x{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;max-width:100%;min-width:0}
.pib-span-first > :first-child{grid-column:1 / -1}
.pib-ui .pib-select{width:auto;max-width:100%}
.pib-ui .pib-field .pib-select{width:100%}
.pib-tabs{scrollbar-width:none;-ms-overflow-style:none}
.pib-tabs::-webkit-scrollbar{display:none}
.pib-link-card{transition:background-color 120ms ease,border-color 120ms ease}
.pib-link-card:hover{background-color:color-mix(in oklab,var(--accent) 55%,transparent)}
.pib-link-card:focus-visible,.pib-chart:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.pib-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes pib-pulse{0%{transform:scale(1);opacity:.55}80%,100%{transform:scale(2.6);opacity:0}}
.pib-pulse::after{content:"";position:absolute;inset:0;border-radius:999px;background:currentColor;animation:pib-pulse 1.8s ease-out infinite}
@media (prefers-reduced-motion:reduce){.pib-pulse::after{animation:none}.pib-ui *{transition:none !important}}
@media ${NARROW_QUERY}{
  .pib-ui :where(${TEXT_INPUTS},select,textarea){font-size:16px !important}
}
@media (pointer:coarse){
  .pib-ui :where(button,[role=tab],select,${TEXT_INPUTS}){min-height:40px}
  .pib-ui :where(input[type=checkbox],input[type=radio]){width:20px;height:20px}
  .pib-tabs > :where(a,button){min-height:40px}
}
`;

/**
 * Adds the shared base rules and colour tokens to the document once. Page, PageFrame, Modal, Sheet,
 * NewTaskDialog and every colour/chart component call it; call it yourself in a custom page root that
 * has `className="pib-ui"`.
 */
export function usePibBaseStyles(): void {
  useInsertionEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = BASE_CSS;
    document.head.appendChild(el);
  }, []);
}
