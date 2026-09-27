/**
 * The client's CRM profile, read by the SEO page to preselect the 90-day plan
 * when a sprint is created. The SEO worker may not read the CRM's tables, but
 * the page runs as the signed-in person, who can call the CRM's read-only
 * `crm.client-workspace` action. Anything missing or failing gives null and
 * the page falls back to a local service business for a client.
 */
import type { ClientRef } from "@partnersinbiz/pib-plugin-kit/client-ref";
import type { ProfileHint } from "../engine/business-type.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Services, audience, website and name from the CRM's workspace answer (`{ data: … }` or the bare body). Pure. */
export function parseCrmWorkspace(body: unknown): ProfileHint | null {
  const root = record(body);
  const data = record(root?.data) ?? root;
  if (!data || data.found === false) return null;
  const profile = record(data.profile);
  const company = record(data.company);
  const contact = record(data.contact);
  const services = Array.isArray(profile?.services) ? profile!.services.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  const hint: ProfileHint = {
    services,
    audience: text(profile?.audience),
    website: text(profile?.website) ?? text(company?.domain),
    name: text(company?.name) ?? text(contact?.name),
  };
  return services.length || hint.audience || hint.website || hint.name ? hint : null;
}

export async function readCrmProfile(companyId: string, client: ClientRef): Promise<ProfileHint | null> {
  try {
    const res = await fetch("/api/plugins/partnersinbiz.crm/actions/crm.client-workspace", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ companyId, params: { kind: client.kind, id: client.id } }),
    });
    if (!res.ok) return null;
    return parseCrmWorkspace(await res.json().catch(() => null));
  } catch {
    return null;
  }
}
