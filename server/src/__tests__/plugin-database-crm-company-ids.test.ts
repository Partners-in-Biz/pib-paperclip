import { describe, expect, it } from "vitest";
import { validatePluginRuntimeQuery } from "../services/plugin-database.js";

// PAR-8198: the CRM's live-company filter must pass the host's runtime SQL guard with its manifest's core tables.
const NS = "plugin_crm_832258244c";
const SQL = `SELECT ids.company_id FROM (SELECT company_id FROM ${NS}.companies
     UNION
     SELECT company_id FROM ${NS}.contacts) AS ids
       JOIN public.companies AS c ON c.id::text = ids.company_id::text
       WHERE c.status <> 'archived'`;

describe("CRM crmCompanyIds query vs plugin SQL guard", () => {
  it("is allowed when companies is a declared core read table", () => {
    expect(() => validatePluginRuntimeQuery(SQL, NS, ["heartbeat_runs", "issues", "cost_events", "companies"])).not.toThrow();
  });

  it("is refused without the companies core read (so the plugin fallback path is real)", () => {
    expect(() => validatePluginRuntimeQuery(SQL, NS, ["heartbeat_runs", "issues", "cost_events"])).toThrow();
  });
});
