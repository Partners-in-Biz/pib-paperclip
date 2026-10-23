import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle, folderPaths, isFolder, type FakeFile } from "./support/fake-google-drive.js";

const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };

/** The tool layer on the native path: the service account key in the CRM settings, Google (faked, in memory) as the only server. */
async function setup(config: Record<string, any> = NATIVE, store?: Record<string, any>, google = fakeGoogle()) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const fetchSpy = vi.fn(google.fetchFn);
  vi.stubGlobal("fetch", fetchSpy);
  return { harness, google, fetchSpy };
}

function linked(baseSeed: Record<string, any>, coId: string, name: string) {
  const contactId = `contact-${coId}`;
  baseSeed.companies!.push(company(coId, name));
  baseSeed.contacts!.push(contact(contactId, "Primary Contact"));
  baseSeed.contact_companies!.push({ id: `cc-${coId}`, company_id: CO, contact_id: contactId, account_id: coId, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  baseSeed.client_projects!.push({ id: `cp-${coId}`, company_id: CO, project_id: "p1", client_kind: "company", client_ref: coId, created_at: "2026-01-01T00:00:00Z" });
}

/** The folder Drive holds for a Paperclip entity (its registry is the appProperties on the folder). */
const folderOf = (files: FakeFile[], type: string, id: string) => files.find((f) => isFolder(f) && f.appProperties?.pibEntityType === type && f.appProperties?.pibEntityId === id);

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("Drive folder tools", () => {
  it("declares resolve, ensure, file-save, set, list, and binding tools with schemas and descriptions", () => {
    expect(DRIVE_TOOLS).toHaveLength(8);
    expect(DRIVE_TOOLS[0].name).toBe("drive_folder_resolve");
    expect(DRIVE_TOOLS[1].name).toBe("drive_folder_ensure");
    expect(DRIVE_TOOLS[2].name).toBe("drive_file_save");
    expect(DRIVE_TOOLS[3].name).toBe("drive_project_kind_set");
    expect(DRIVE_TOOLS[4].name).toBe("drive_project_kind_list");
    expect(DRIVE_TOOLS[5].name).toBe("drive_binding_discover");
    expect(DRIVE_TOOLS[6].name).toBe("drive_binding_set");
    expect(DRIVE_TOOLS[7].name).toBe("drive_binding_status");
    expect(DRIVE_TOOLS[0].description).toContain("Never hard-code");
    expect(DRIVE_TOOLS[0].description).toContain("ALWAYS call this first");
    expect(DRIVE_TOOLS[1].description).toContain("Never hard-code");
    expect(DRIVE_TOOLS[2].description).toContain("deduplicates");
    expect(DRIVE_TOOLS[3].description).toContain("Drive folder kind");
    expect(DRIVE_TOOLS[4].description).toContain("read-only");
    expect(DRIVE_TOOLS[5].description).toContain("Shared Drives");
    expect(DRIVE_TOOLS[6].description).toContain("Shared Drive");
    expect(DRIVE_TOOLS[7].description).toContain("read-only");
  });

  it("(a) company-linked project idempotent: create then exists, nothing new in Drive", async () => {
    const st = seed();
    linked(st, "co-a", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.data?.status).toBe("created");
    expect(r1.data?.path).toBe("Acme Ltd (Primary Contact)/Website");
    const files1 = google.files.length;
    expect(files1).toBeGreaterThan(0);
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("exists");
    expect(r2.data?.folder_id).toBe(r1.data?.folder_id);
    expect(google.files.length).toBe(files1);
  });

  it("(b) unlinked project: its folder sits at the Shared Drive root, with no company folder above it", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p-unlinked", companyId: CO, name: "Solo" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-unlinked" });
    const project = folderOf(google.files, "project", "p-unlinked");
    expect(project).toMatchObject({ name: "Solo", parents: [DRIVE_ID] });
    expect(google.files.some((f) => f.appProperties?.pibEntityType === "crm_company")).toBe(false);
  });

  it("(c) company-linked: company folder 'Acme Ltd (Primary Contact)' at the root, the project folder inside it", async () => {
    const st = seed();
    linked(st, "co-c", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const companyFolder = folderOf(google.files, "crm_company", "co-c");
    expect(companyFolder).toMatchObject({ name: "Acme Ltd (Primary Contact)", parents: [DRIVE_ID] });
    const projectFolder = folderOf(google.files, "project", "p1");
    expect(projectFolder).toMatchObject({ name: "Website", parents: [companyFolder!.id], description: "Acme Ltd (Primary Contact)/Website" });
  });

  it("(d) every Drive call is scoped to the bound Shared Drive and nothing lands outside it; no key material in the result", async () => {
    const st = seed();
    linked(st, "co-d", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(google.calls.length).toBeGreaterThan(0);
    expect(google.calls.every((c) => c.includes("supportsAllDrives=true"))).toBe(true);
    expect(google.calls.filter((c) => c.startsWith("GET")).every((c) => c.includes(`driveId=${DRIVE_ID}`))).toBe(true);
    // The agent passes no folder id; every folder hangs off the Shared Drive root or a folder made in this run.
    const ids = new Set(google.files.map((f) => f.id));
    for (const f of google.files) for (const parent of f.parents) expect(parent === DRIVE_ID || ids.has(parent)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY|private_key|ya29/);
  });

  it("(e) UUID/PAR-123/Drive-id → invalid_name, nothing is created", async () => {
    const { harness, google } = await setup();
    for (const n of ["3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c", "PAR-123", "1AbCdEfGhIjKlMnOpQrStUvWxYz012335"]) {
      harness.seed({ projects: [{ id: `p${n}`, companyId: CO, name: n } as never] });
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: `p${n}` });
      expect(r.data?.status).toBe("invalid_name");
    }
    expect(google.files).toHaveLength(0);
    expect(google.calls.every((c) => c.startsWith("GET"))).toBe(true);
  });

  it("(f) name collision → needs_human_look, nothing new in Drive", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Café Plan" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const files1 = google.files.length;
    expect(files1).toBeGreaterThan(0);
    harness.seed({ projects: [{ id: "p2", companyId: CO, name: "cafe  plan" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });
    expect(r.data?.status).toBe("needs_human_look");
    expect(r.data?.conflictsWith).toEqual([{ entityType: "project", entityId: "p1", name: "Café Plan" }]);
    expect(google.files.length).toBe(files1);
  });

  it("(g) Google 503 part-way: retryable error, the retry resumes and no folder is duplicated", async () => {
    const st = seed();
    linked(st, "co-g", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    // The company folder is created, then Google fails the project folder.
    google.failNext({ method: "POST", skip: 1, status: 503 });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.error).toContain("retryable");
    expect(r1.error).toContain("Nothing was renamed or deleted");
    expect(folderPaths(google.files)).toEqual(["Acme Ltd (Primary Contact)"]);
    const companyId = google.files[0].id;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("created");
    const paths = folderPaths(google.files);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(8); // company + project + six numbered sub-folders
    expect(google.files.filter((f) => f.name.startsWith("Acme Ltd"))).toHaveLength(1);
    expect(google.files[0].id).toBe(companyId);
  });

  it("(g2) a response lost after the folder was created is adopted on retry, not duplicated", async () => {
    const st = seed();
    linked(st, "co-g2", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    // Drive creates the project folder, then the answer is lost (a 502 on the way back).
    google.failNext({ method: "POST", skip: 1, status: 502, applyFirst: true });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.error).toContain("retryable");
    expect(folderPaths(google.files)).toEqual(["Acme Ltd (Primary Contact)", "Acme Ltd (Primary Contact)/P"]);
    const lost = folderOf(google.files, "project", "p1")!;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    // Adopted, and the interrupted ensure is resumed: the numbered sub-folders are made, not reported as "exists" with nothing in them.
    expect(r2.data?.status).toBe("created");
    expect(r2.data?.folder_id).toBe(lost.id);
    expect(google.files.filter((f) => isFolder(f) && f.parents.includes(lost.id)).map((f) => f.name).sort()).toEqual(["01 Briefs", "02 Assets", "03 Deliverables", "04 Reports", "05 Evidence", "99 Archive"]);
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("exists");
    expect(google.files.filter((f) => f.name === "P")).toHaveLength(1);
    const paths = folderPaths(google.files);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("(g3) a marketing project resolves after its ensure (its leaf is a campaign folder), and a repeat creates nothing", async () => {
    const { harness, google } = await setup(NATIVE);
    harness.seed({ projects: [{ id: "pm", companyId: CO, name: "Spring Launch" } as never] });
    await toolRaw(harness, "drive_project_kind_set", { projectId: "pm", kind: "marketing", scopeRef: "PiB" });
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "pm" })).data?.status).toBe("created");
    const count = google.files.length;
    expect(folderOf(google.files, "campaign", "pm")).toBeDefined();
    const found = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "pm" });
    expect(found.data?.status).toBe("found");
    expect(found.data?.path).toBe("Marketing/PiB/Spring Launch");
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "pm" })).data?.status).toBe("exists");
    expect(google.files.length).toBe(count);
  });

  it("(g4) the run that created a folder is recorded on it", async () => {
    const st = seed();
    linked(st, "co-g4", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(folderOf(google.files, "project", "p1")?.appProperties?.pibRun).toBe("run-1");
  });

  it("(h) resolve: not_found→ensure→found; bad entity_type errors", async () => {
    const { harness } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    let r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("not_found");
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("found");
    r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "bad", entity_id: "p1" });
    expect(r.error).toBeDefined();
  });

  it("(i) no service account key → error naming driveServiceAccountJson, and Google is never called", async () => {
    const { harness, fetchSpy } = await setup({});
    harness.seed({ projects: [{ id: "p", companyId: CO, name: "P" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p" });
    expect(r.error).toContain("driveServiceAccountJson");
    const resolved = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p" });
    expect(resolved.data?.status).toBe("not_configured");
    expect(resolved.data?.error).toContain("driveServiceAccountJson");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("(k) Google 403 (service account not in the Shared Drive) fails the tool non-retryable, naming the fix, creating nothing", async () => {
    const st = seed();
    linked(st, "co-k", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st, fakeGoogle({ filesStatus: 403 }));
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.error).toContain("Drive broker failed");
    expect(r.error).toContain("Content manager");
    expect(r.error).not.toContain("retryable");
    expect(google.files).toHaveLength(0);
  });

  it("(l) company sibling collision vs unlinked non-collision", async () => {
    const st = seed();
    linked(st, "co-l", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    st.client_projects!.push({ id: "cp2", company_id: CO, project_id: "p2", client_kind: "company", client_ref: "co-l", created_at: "2026-01-01T00:00:00Z" });
    harness.seed({ projects: [{ id: "p2", companyId: CO, name: "Site" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });
    expect(r.data?.status).toBe("needs_human_look");
    expect(folderOf(google.files, "project", "p2")).toBeUndefined();
    harness.seed({ projects: [{ id: "p3", companyId: CO, name: "Site" } as never] });
    const r3 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p3" });
    expect(r3.data?.status).toBe("created");
    // The unlinked "Site" is its own folder at the root; the client's "Site" stays inside its company folder.
    expect(folderOf(google.files, "project", "p3")).toMatchObject({ name: "Site", parents: [DRIVE_ID] });
    expect(folderPaths(google.files)).toEqual(expect.arrayContaining(["Acme Ltd (Primary Contact)/Site", "Site"]));
  });

  it("(m) resolve returns the very folder ensure made, with a Drive link to it", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    const made = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    const folder = folderOf(google.files, "project", "p1")!;
    expect(r.data?.status).toBe("found");
    expect(r.data?.folder_id).toBe(folder.id);
    expect(made.data?.folder_id).toBe(folder.id);
    expect(r.data?.url).toContain(folder.id);
    expect(r.data?.path).toBe("P");
  });

  it("(n) company name collision: two crm_company siblings with the same folder key → needs_human_look, no folder", async () => {
    const st = seed();
    // Two companies whose names normalize to the same folder key
    st.companies!.push(company("co-n1", "Acme Ltd"));
    st.companies!.push(company("co-n2", "acme  ltd"));
    st.contacts!.push(contact("con-n1", "Primary Contact"));
    st.contacts!.push(contact("con-n2", "Primary Contact"));
    st.contact_companies!.push({ id: "cc-n1", company_id: CO, contact_id: "con-n1", account_id: "co-n1", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    st.contact_companies!.push({ id: "cc-n2", company_id: CO, contact_id: "con-n2", account_id: "co-n2", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    const { harness, google } = await setup(NATIVE, st);
    for (const id of ["co-n1", "co-n2"]) {
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: id });
      expect(r.data?.status).toBe("needs_human_look");
    }
    expect(google.files).toHaveLength(0);
  });

  it("(p) network error before Google answers (token call) → a plain tool error 'Drive broker failed', not a raw BrokerError", async () => {
    const { harness } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network timeout");
    });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.error).toBeDefined();
    expect(r.error).toContain("Drive broker failed");
    expect(r.error).toContain("Network timeout");
  });

  it("(p2) network error on the Drive call itself → 'Drive broker failed', for ensure and for resolve", async () => {
    const google = fakeGoogle();
    const { harness } = await setup(NATIVE, undefined, google);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (new URL(url).hostname === "oauth2.googleapis.com") return google.fetchFn(url, init);
      throw new Error("socket hang up");
    });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.error).toContain("Drive broker failed");
    expect(r.error).toContain("socket hang up");
    const resolved = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(resolved.error).toContain("Drive broker failed");
  });

  it("(q) long CamelCase name rejected as drive_id", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProjectManagementDashboardV2" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("invalid_name");
    expect(r.data?.problem).toBe("drive_id");
    expect(google.files).toHaveLength(0);
  });
});
