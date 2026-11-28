/**
 * Access stage B-3 (PAR-15205; plan PAR-12581 B-D3, B-D5): under a `linked` decision the client rows follow the
 * person's own companies. Jan (preset Client manager) owns Acme; Globex is not his; "own" rows (our own lead form,
 * event key) name no client. The owner made every row with the switch off. Per area: Acme's rows open, Globex's id,
 * a guessed id and our own rows are refused or not listed; the Drive reads are actions (no data handler is left). The
 * owner on enforce and Jan with the switch off keep today's answer (the parity test).
 */
import { describe, expect, it } from "vitest";
import { accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { BOARD, CO, bootCare, enableFor, makeDoc, tool } from "./helpers/esign.js";
import { careSeed, company, type Route } from "./helpers/care.js";

const JAN = "user-jan";
const at = "2026-11-01T00:00:00Z";
const member = (userId: string, role: string) => ({
  id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at,
});
/** `managedAccountIds` (the CRM's own-companies resolver) on the fake store. */
const MANAGED: Route = [/manager_user_ids @> jsonb_build_array/, (p, s) =>
  (s.companies ?? []).filter((row) => row.company_id === p[0] && (row.owner_user_id === p[1] || ((row.manager_user_ids as string[] | undefined) ?? []).includes(String(p[1])))).map((row) => ({ id: row.id }))];
const driveFile = (id: string, projectId: string) => ({
  id, company_id: CO, project_id: projectId, kind: "client", folder_id: "f-root", name: `${id}.pdf`, sha256: id, drive_file_id: `gd-${id}`,
  web_url: `https://drive.google.com/file/d/${id}/view`, source_plugin: "crm", subfolder: "Deliverables", created_at: at,
});

/** Rows for Acme (Jan's), Globex (not his) and our own, made by the owner with the switch off; then the switch is set. */
async function world(mode: "off" | "report" | "enforce" | null) {
  const store = careSeed({ companies: [
    company("acme", "Acme Plumbing", { domain: "acme.co.za", lifecycle: "customer", owner_user_id: JAN }),
    company("globex", "Globex", { domain: "globex.test", lifecycle: "customer" }),
    { ...company("foreign", "Foreign Co"), company_id: "co-2" },
  ] });
  const booted = await bootCare({ store, routes: [MANAGED] });
  const { harness } = booted;
  harness.seed({
    accessMembers: [member(BOARD.userId, "owner"), member(JAN, "member")] as never,
    projects: ["p-acme", "p-globex", "p-free"].map((id) => ({ id, companyId: CO, name: `Project ${id}` })) as never,
  });
  const owner = (key: string, params: Record<string, unknown>) => harness.performAction<Record<string, any>>(key, params, { companyId: CO, actor: BOARD });
  const sites = {
    acme: (await owner("crm.save-client-site", { client: "company:acme", url: "https://acme.co.za", platform: "wordpress" })).site.id as string,
    globex: (await owner("crm.save-client-site", { client: "company:globex", url: "https://globex.test", platform: "wordpress" })).site.id as string,
  };
  const forms = {
    acme: (await owner("crm.create-lead-endpoint", { client: "company:acme" })).source.id as string,
    globex: (await owner("crm.create-lead-endpoint", { client: "company:globex" })).source.id as string,
    own: (await owner("crm.create-lead-endpoint", {})).source.id as string,
  };
  const keys = {
    acme: (await owner("crm.create-event-key", { client: "company:acme" })).key.id as string,
    globex: (await owner("crm.create-event-key", { client: "company:globex" })).key.id as string,
    own: (await owner("crm.create-event-key", {})).key.id as string,
  };
  await enableFor(booted, "company:acme");
  await enableFor(booted, "company:globex");
  const docs = { acme: (await makeDoc(booted, "company:acme")).documentId, globex: (await makeDoc(booted, "company:globex")).documentId };
  const cases = {
    acme: (await tool<Record<string, any>>(harness, "open-support-case", { client: "company:acme", title: "Printer", source: "portal" })).caseId as string,
    globex: (await tool<Record<string, any>>(harness, "open-support-case", { client: "company:globex", title: "Globex outage", source: "portal" })).caseId as string,
  };
  await owner("crm.link-client-project", { client: "company:acme", projectId: "p-acme" });
  await owner("crm.link-client-project", { client: "company:globex", projectId: "p-globex" });
  booted.store.drive_files = [driveFile("acme-file", "p-acme"), driveFile("globex-file", "p-globex"), driveFile("own-file", "p-free")];

  if (mode) await harness.ctx.state.set(accessCompanyScope(CO), { mode, rev: 1, userIds: [], receivedAt: new Date().toISOString() });
  await harness.ctx.state.set(accessGrantScope(CO, JAN), { preset: "clientManager" });
  const act = <T = Record<string, any>>(key: string, params: Record<string, unknown>, userId = JAN) =>
    harness.performAction<T>(key, params, { companyId: CO, actor: { type: "user" as const, userId } });
  /** An agent tool for the person (the host sends the acting person). */
  const asJan = (name: string, params: Record<string, unknown>, userId = JAN) =>
    harness.executeTool<{ data?: Record<string, any>; error?: string }>(name, params, { companyId: CO, agentId: "agent-1", runId: "run-1", onBehalfOfUserId: userId, onBehalfOfRestricted: false });
  /** Refused: a guard refusal or the handler's error. */
  const refused = async (key: string, params: Record<string, unknown>) => {
    const out = await act(key, params).then((value) => value, (error: unknown) => error as Error);
    return out instanceof Error || isRefusal(out);
  };
  return { ...booted, act, asJan, refused, sites, forms, keys, docs, cases };
}

const NOT_HIS = /not found|not visible|names no client|full CRM access/i;

describe("stage B-3: a limited person on enforce works only on his companies' client rows", () => {
  it("sites and the wp-* tools: Acme's site opens; Globex's site, a guessed site id and Globex as client are refused", async () => {
    const { asJan, refused, sites } = await world("enforce");
    const list = (await asJan("list-client-sites", { client: "company:acme" })).data!;
    expect(list.sites.map((site: { id: string }) => site.id)).toEqual([sites.acme]);
    expect((await asJan("site-changes", { siteId: sites.acme })).error).toBeUndefined();
    expect((await asJan("list-client-sites", { client: "company:globex" })).error).toMatch(NOT_HIS);
    for (const siteId of [sites.globex, "guess-1"]) {
      for (const name of ["site-changes", "check-client-site", "wp-health", "wp-seo"]) {
        expect((await asJan(name, { siteId, op: "get", url: "https://globex.test/" })).error, `${name} ${siteId}`).toMatch(NOT_HIS);
      }
      expect(await refused("crm.delete-client-site", { siteId }), siteId).toBe(true);
    }
    expect((await asJan("save-client-site", { client: "company:globex", url: "https://globex2.test" })).error).toMatch(NOT_HIS);
    expect((await asJan("site-monitoring", { client: "company:globex" })).error).toMatch(NOT_HIS);
    // A site's project must be its own client's: Globex's project or an unlinked one is refused, Acme's opens.
    for (const projectId of ["p-globex", "p-free"]) {
      expect((await asJan("save-client-site", { siteId: sites.acme, projectId })).error, projectId).toMatch(NOT_HIS);
    }
    expect((await asJan("save-client-site", { siteId: sites.acme, projectId: "p-acme" })).error).toBeUndefined();
  });

  it("another client's site, document and case give the same text as a guessed id (stage B2)", async () => {
    const { asJan, sites, docs, cases } = await world("enforce");
    const same = async (name: string, key: string, other: string, extra: Record<string, unknown>) => {
      const a = (await asJan(name, { [key]: other, ...extra })).error;
      const b = (await asJan(name, { [key]: "guess-1", ...extra })).error;
      expect(a, name).toBeTruthy();
      expect(a!.split(other).join("ID"), name).toBe(b!.split("guess-1").join("ID"));
      expect(a, name).toMatch(/was not found/);
      expect(a, name).not.toMatch(/not visible/);
    };
    await same("save-client-site", "siteId", sites.globex, { projectId: "p-acme" });
    await same("get-sign-document", "documentId", docs.globex, {});
    await same("update-support-case", "caseId", cases.globex, { status: "in_progress" });
  });

  it("lead forms and event keys: Acme's only; Globex's and our own (no client) are refused and not listed", async () => {
    const { act, asJan, forms, keys } = await world("enforce");
    expect((await act("crm.list-lead-sources", {})).sources.map((row: { id: string }) => row.id)).toEqual([forms.acme]);
    expect((await act("crm.list-lead-sources", { ownOnly: true })).sources).toEqual([]);
    expect((await act("crm.list-event-keys", {})).keys.map((row: { id: string }) => row.id)).toEqual([keys.acme]);
    for (const sourceId of [forms.globex, forms.own, "guess-1"]) {
      expect((await asJan("update-lead-source", { sourceId, status: "paused" })).error, sourceId).toMatch(NOT_HIS);
      expect((await asJan("rotate-lead-key", { sourceId })).error, sourceId).toMatch(NOT_HIS);
    }
    for (const keyId of [keys.globex, keys.own, "guess-1"]) {
      expect((await asJan("rotate-event-key", { keyId })).error, keyId).toMatch(NOT_HIS);
    }
    expect((await asJan("create-lead-endpoint", {})).error).toMatch(/names no client/);
    expect((await asJan("create-event-key", {})).error).toMatch(/names no client/);
    expect((await asJan("create-lead-endpoint", { client: "company:globex" })).error).toMatch(NOT_HIS);
    expect((await asJan("update-lead-source", { sourceId: forms.acme, status: "paused" })).error).toBeUndefined();
  });

  it("e-sign: Acme's documents only; Globex's document and a guessed id are refused; the templates open", async () => {
    const { asJan, docs } = await world("enforce");
    const list = (await asJan("list-sign-documents", { status: "all" })).data!;
    expect(list.documents.map((doc: { documentId?: string; id?: string }) => doc.documentId ?? doc.id)).toEqual([docs.acme]);
    expect((await asJan("get-sign-document", { documentId: docs.acme })).error).toBeUndefined();
    for (const documentId of [docs.globex, "guess-1"]) {
      for (const name of ["get-sign-document", "verify-sign-document", "send-for-signature"]) expect((await asJan(name, { documentId })).error, `${name} ${documentId}`).toMatch(NOT_HIS);
      expect((await asJan("void-sign-document", { documentId, reason: "Wrong client" })).error).toMatch(NOT_HIS);
    }
    expect((await asJan("create-sign-document", { client: "company:globex", template: "proposal", variables: { scope: "x" } })).error).toMatch(NOT_HIS);
    expect((await asJan("sign-templates", {})).data?.templates.length).toBeGreaterThan(0);
  });

  it("care: Acme's cases only; Globex's case, reports, health and sensitivity are refused", async () => {
    const { asJan, cases } = await world("enforce");
    const list = (await asJan("list-support-cases", {})).data!;
    expect(JSON.stringify(list)).toContain(cases.acme);
    expect(JSON.stringify(list)).not.toContain(cases.globex);
    for (const caseId of [cases.globex, "guess-1"]) expect((await asJan("update-support-case", { caseId, status: "in_progress" })).error, caseId).toMatch(NOT_HIS);
    for (const name of ["list-client-reports", "client-health", "list-client-actions", "set-client-sensitivity", "record-client-signal", "open-support-case"]) {
      expect((await asJan(name, { client: "company:globex", level: "high", reason: "x", kind: "praise", title: "x", source: "portal", note: "x" })).error, name).toMatch(NOT_HIS);
    }
    expect(JSON.stringify((await asJan("client-health", {})).data)).not.toMatch(/globex/i);
    expect((await asJan("record-channel-cost", { channel: "organic_search", period: "2026-10", amountMinor: 100 })).error).toMatch(/names no client/);
  });

  it("projects: his client's projects; no unlinked projects shown, no new link; Globex's are refused", async () => {
    const { act, asJan, refused } = await world("enforce");
    const acme = (await asJan("list-client-projects", { client: "company:acme" })).data!;
    expect(acme.projects.map((row: { projectId: string }) => row.projectId)).toEqual(["p-acme"]);
    expect(acme.unlinkedProjects).toEqual([]);
    const workspace = await act("crm.client-workspace", { kind: "company", id: "acme" });
    expect(JSON.stringify(workspace)).not.toContain("p-free");
    expect((await asJan("list-client-projects", { client: "company:globex" })).error).toMatch(NOT_HIS);
    expect((await asJan("link-client-project", { client: "company:acme", projectId: "p-free" })).error).toMatch(/full CRM access/);
    expect((await asJan("link-client-project", { client: "company:acme", projectId: "p-acme", kind: "seo" })).error).toBeUndefined();
    expect(await refused("crm.unlink-client-project", { client: "company:globex", projectId: "p-globex" })).toBe(true);
  });

  it("Drive: the page actions and tools open his client's project and company only; another client's, ours and a guessed id are refused", async () => {
    const { act, asJan, refused } = await world("enforce");
    const files = await act<{ groups: Array<{ files: Array<{ name: string }> }> }>("crm.drive-files", { projectId: "p-acme" });
    expect(files.groups.flatMap((group) => group.files.map((file) => file.name))).toEqual(["acme-file.pdf"]);
    expect(await act("crm.drive-folder", { crmCompanyId: "acme" })).toEqual({ folder: null });
    for (const projectId of ["p-globex", "p-free", "guess-1"]) {
      expect(await refused("crm.drive-files", { projectId }), projectId).toBe(true);
      for (const name of ["drive_files_list", "drive_file_save", "drive_project_kind_set", "drive_file_fetch"]) {
        expect((await asJan(name, { projectId, fileId: "gdFileId12345", fileKind: "client", name: "x.pdf", mimeType: "application/pdf", contentBase64: "eA==", kind: "client" })).error, `${name} ${projectId}`).toMatch(NOT_HIS);
      }
      expect((await asJan("drive_folder_resolve", { entity_type: "project", entity_id: projectId })).error, projectId).toMatch(NOT_HIS);
    }
    for (const crmCompanyId of ["globex", "foreign", "guess-1"]) {
      expect(await refused("crm.drive-folder", { crmCompanyId }), crmCompanyId).toBe(true);
      expect((await asJan("drive_folder_ensure", { entity_type: "crm_company", entity_id: crmCompanyId })).error, crmCompanyId).toMatch(NOT_HIS);
    }
    const kinds = (await asJan("drive_project_kind_list", {})).data!;
    expect(kinds.projects.map((row: { projectId: string }) => row.projectId)).toEqual(["p-acme"]);
    expect(isRefusal(await act("crm.drive-files", { projectId: "p-acme" }))).toBe(false);
  });

  it("company-wide areas stay closed to him: attribution, site events and Drive trash", async () => {
    const { asJan } = await world("enforce");
    for (const name of ["attribution-report", "site-events-report"]) expect((await asJan(name, { client: "company:acme" })).error, name).toBeTruthy();
    expect((await asJan("drive_file_trash", { fileId: "gd-acme-file" })).error).toBeTruthy();
  });
});

describe("stage B-3 parity: the owner on enforce, and Jan with the switch off or on report, get today's answer", () => {
  it("the owner on enforce lists every client's rows and our own, and reads any project's Drive files", async () => {
    const { act, asJan, forms, keys } = await world("enforce");
    const sources = (await act("crm.list-lead-sources", {}, BOARD.userId)).sources.map((row: { id: string }) => row.id).sort();
    expect(sources).toEqual([forms.acme, forms.globex, forms.own].sort());
    expect((await act("crm.list-event-keys", {}, BOARD.userId)).keys).toHaveLength(Object.keys(keys).length);
    const files = await act<{ groups: Array<{ files: unknown[] }> }>("crm.drive-files", { projectId: "p-globex" }, BOARD.userId);
    expect(files.groups.flatMap((group) => group.files)).toHaveLength(1);
    expect((await asJan("list-client-projects", { client: "company:acme" }, BOARD.userId)).data!.unlinkedProjects.map((row: { projectId: string }) => row.projectId)).toEqual(["p-free"]);
  });

  it.each([null, "off", "report"] as const)("switch %s: Jan's lists and Drive reads are today's (our own rows listed, no own-companies filter)", async (mode) => {
    const { act, forms } = await world(mode);
    const sources = (await act("crm.list-lead-sources", {})).sources.map((row: { id: string }) => row.id);
    // Today's rule: a client's form follows client visibility (Jan owns Acme); our own forms are listed to everyone.
    expect(sources.sort()).toEqual([forms.acme, forms.own].sort());
    const files = await act<{ groups: Array<{ files: unknown[] }> }>("crm.drive-files", { projectId: "p-free" });
    expect(files.groups.flatMap((group) => group.files)).toHaveLength(1);
  });
});
