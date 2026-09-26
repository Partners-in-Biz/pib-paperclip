/**
 * Module accents: each PiB plugin has one accent colour (CRM blue, Social
 * rose, …) that tints its header icon, the active tab and single-series
 * charts. Wrap a page in `PluginThemeProvider` (or pass `accent` to `Page`)
 * and the components pick it up.
 */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { usePibBaseStyles } from "./base.js";
import { DEFAULT_ICON, MODULE_ICONS } from "./icons.js";
import { accentColors, moduleKeyOf, type AccentColors, type ModuleKey } from "./tokens.js";

export interface ModuleAccent extends AccentColors {
  icon: LucideIcon;
}

/** Accent colours and icon for a module key (`crm`) or plugin key (`partnersinbiz.crm`). Unknown keys get the info blue. */
export function moduleAccent(key: ModuleKey | string | null | undefined): ModuleAccent {
  const module = moduleKeyOf(key ?? null);
  if (!module) {
    return {
      key: null,
      label: key ?? "",
      icon: DEFAULT_ICON,
      solid: "var(--pib-info, #2563eb)",
      soft: "var(--pib-info-soft, color-mix(in srgb, #2563eb 10%, transparent))",
      border: "var(--pib-info-border, color-mix(in srgb, #2563eb 28%, transparent))",
      fg: "var(--pib-info-fg, color-mix(in srgb, #2563eb 68%, black))",
    };
  }
  return { ...accentColors(module), icon: MODULE_ICONS[module] };
}

/** Anything a component accepts as `accent`. */
export type AccentInput = ModuleKey | string | ModuleAccent | AccentColors | null | undefined;

export function resolveAccent(input: AccentInput): ModuleAccent | null {
  if (!input) return null;
  if (typeof input === "string") return moduleAccent(input);
  return "icon" in input ? input : { ...input, icon: input.key ? MODULE_ICONS[input.key] : DEFAULT_ICON };
}

/** The CSS variables that make `tone("accent")` and accent-aware components use this accent. */
export function accentVars(accent: AccentInput): CSSProperties {
  const a = resolveAccent(accent);
  if (!a) return {};
  return {
    ["--pib-accent" as string]: a.solid,
    ["--pib-accent-soft" as string]: a.soft,
    ["--pib-accent-border" as string]: a.border,
    ["--pib-accent-fg" as string]: a.fg,
  } as CSSProperties;
}

const AccentContext = createContext<ModuleAccent | null>(null);

/** The accent of the nearest `PluginThemeProvider` (or `Page accent`), or null. */
export function useAccent(): ModuleAccent | null {
  return useContext(AccentContext);
}

/** `accent` prop if given, else the provider's accent. */
export function useResolvedAccent(accent?: AccentInput): ModuleAccent | null {
  const ctx = useAccent();
  return resolveAccent(accent) ?? ctx;
}

/**
 * Gives everything inside it the module's accent (header icon, active tab,
 * charts, `tone("accent")`). Renders a `display: contents` wrapper, so it does
 * not change layout.
 */
export function PluginThemeProvider({ accent, children }: { accent: AccentInput; children: ReactNode }) {
  usePibBaseStyles();
  const resolved = resolveAccent(accent);
  return (
    <AccentContext.Provider value={resolved}>
      <div data-pib-accent={resolved?.key ?? undefined} style={{ display: "contents", ...accentVars(resolved) }}>{children}</div>
    </AccentContext.Provider>
  );
}

export { AccentContext };
