/**
 * Host API calls from the Payroll page (same origin, board session cookie),
 * after the Setup plugin's `ui/api.ts`: the saved Payroll settings (read and
 * save back in full) and the company's people.
 */
import { parseUserDirectory, type DirectoryPerson } from "./approver.js";

const PLUGIN_KEY = "partnersinbiz.payroll";

/** A host request that failed, with its HTTP status (401/403 = not allowed). */
export class HostRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HostRequestError";
  }
}

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/** Payroll's saved settings for a company (`{}` when never saved). */
export async function fetchPayrollConfig(companyId: string): Promise<{ saved: boolean; config: Record<string, unknown> }> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(PLUGIN_KEY)}/config?companyId=${encodeURIComponent(companyId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await readJson(res);
  if (!res.ok) throw new HostRequestError("Couldn't read the Payroll settings.", res.status);
  if (!body || typeof body !== "object") return { saved: false, config: {} };
  const configJson = (body as { configJson?: unknown }).configJson;
  const config = configJson && typeof configJson === "object" && !Array.isArray(configJson) ? (configJson as Record<string, unknown>) : {};
  return { saved: true, config };
}

/** Saves the FULL settings object (the host replaces the saved row). Needs an instance admin. */
export async function savePayrollConfig(companyId: string, configJson: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(PLUGIN_KEY)}/config`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ companyId, configJson }),
  });
  if (!res.ok) {
    await readJson(res);
    throw new HostRequestError("Couldn't save the Payroll settings.", res.status);
  }
}

/** The company's active people (names and emails; the ids stay out of sight). */
export async function fetchPeople(companyId: string): Promise<DirectoryPerson[]> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/user-directory`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await readJson(res);
  if (!res.ok) throw new HostRequestError("Couldn't load the people in this company.", res.status);
  return parseUserDirectory(body);
}
