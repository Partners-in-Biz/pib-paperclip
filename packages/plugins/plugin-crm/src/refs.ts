/**
 * Client refs and deep links (`company:<id>` / `contact:<id>`), as every PiB
 * module and the company operating manual use them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { withClientParam } from "@partnersinbiz/pib-plugin-kit";

export type ClientKind = "company" | "contact";

/** `company:<id>` or `contact:<id>`. */
export function refOf(kind: ClientKind, id: string): string {
  return `${kind}:${id}`;
}

/** The modules that keep a client workspace (`/<module>?client=company:<id>`). */
export const WORKSPACE_MODULES = ["crm", "social", "seo", "campaigns", "billing"] as const;
export type WorkspaceModule = (typeof WORKSPACE_MODULES)[number];

/** The company's issue prefix (`PIB`), or null when unknown. Links are prefixed with it. */
export async function companyPrefix(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    return (await ctx.companies.get(companyId))?.issuePrefix ?? null;
  } catch {
    return null;
  }
}

/** The company's own name as its clients know it ("Partners in Biz", "Partners in Apps"), or null when unknown: it signs every email to a client. */
export async function brandName(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    return (await ctx.companies.get(companyId))?.name?.trim() || null;
  } catch {
    return null;
  }
}

/** A Paperclip path, with the company prefix when known: `/PIB/crm?client=company:<id>`. */
export function pagePath(prefix: string | null, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return prefix ? `/${prefix}${clean}` : clean;
}

/** The client's workspace in each module. */
export function workspaceLinks(prefix: string | null, kind: ClientKind, id: string): Record<WorkspaceModule, string> {
  const scope = { kind, id };
  const out = {} as Record<WorkspaceModule, string>;
  for (const module of WORKSPACE_MODULES) out[module] = pagePath(prefix, withClientParam(`/${module}`, scope));
  return out;
}

export function crmLink(prefix: string | null, kind: ClientKind, id: string): string {
  return pagePath(prefix, withClientParam("/crm", { kind, id }));
}

export function issueLink(prefix: string | null, issueId: string): string {
  return pagePath(prefix, `/issues/${issueId}`);
}
