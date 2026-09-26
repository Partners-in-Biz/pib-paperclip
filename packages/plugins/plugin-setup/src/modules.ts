/**
 * Module switches: pure helpers shared by the worker and the page.
 * No node imports (the UI bundle uses this file).
 */
import { MODULE_KEYS, MODULES, type ModuleKey } from "./kit-setup.js";

export type ModuleChoice = Record<ModuleKey, boolean>;

export class SetupError extends Error {}

/** Every module on: what a company without a saved choice gets. */
export function allModulesOn(): ModuleChoice {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as ModuleChoice;
}

/**
 * A full switch map from user input. Unknown keys are dropped; a module the
 * input does not mention stays on. Non-boolean values are refused.
 */
export function normalizeModules(input: unknown): ModuleChoice {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SetupError("modules must be an object of module → true/false");
  const source = input as Record<string, unknown>;
  const result = allModulesOn();
  for (const key of MODULE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new SetupError(`modules.${key} must be true or false`);
    result[key] = value;
  }
  return result;
}

/** The effective switches: saved choice, or everything on. */
export function effectiveModules(saved: Partial<Record<ModuleKey, boolean>> | null | undefined): ModuleChoice {
  const result = allModulesOn();
  if (!saved) return result;
  for (const key of MODULE_KEYS) if (saved[key] === false) result[key] = false;
  return result;
}

/** Modules whose clients come from the CRM. */
export const NEEDS_CRM: readonly ModuleKey[] = ["social", "seo", "billing", "campaigns"];

/** A hint (not a rule) when CRM is off but a module that reads clients from it is on. */
export function crmHint(modules: Partial<Record<ModuleKey, boolean>>): string | null {
  if (modules.crm !== false) return null;
  const users = NEEDS_CRM.filter((key) => modules[key] !== false).map((key) => MODULES[key].title);
  if (users.length === 0) return null;
  return `${users.join(", ")} ${users.length === 1 ? "takes its" : "take their"} clients from the CRM. We recommend keeping CRM on.`;
}

/** Order used everywhere: CRM and Mailbox first (others depend on them), then the kit order. */
export function moduleRank(key: ModuleKey): number {
  if (key === "crm") return 0;
  if (key === "mailbox") return 1;
  return 2 + MODULE_KEYS.indexOf(key);
}

export const ORDERED_MODULES: ModuleKey[] = [...MODULE_KEYS].sort((a, b) => moduleRank(a) - moduleRank(b));
