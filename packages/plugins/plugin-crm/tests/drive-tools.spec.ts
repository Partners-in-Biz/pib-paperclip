import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { CLIENT_SUBFOLDERS, DRIVE_SUBFOLDERS } from "../src/drive/convention.js";
import { DRIVE_ID, KEY_JSON, LAYOUT, REAL_CLIENT_TREE, SEEDED_CLIENT, anchorPaths, fakeGoogle, folderAt, folderPaths, isAnchor, isFolder, rootFolderNames, seedPibDrive, userFolderPaths, type FakeFile } from "./support/fake-google-drive.js";

const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };

/** The tool layer on the native path: the service account key in the CRM settings, Google (faked, in memory) as the only server. */
async function setup(config: Record<string, any> = NATIVE, store?: Record<string, any>, google = fakeGoogle()) {
  const baseStore = store || seed();
  const { harness, db } = await boot({ config, store: baseStore });
  const fetchSpy = vi.fn(google.fetchFn);
  vi.stubGlobal("fetch", fetchSpy);
  return { harness, google, fetchSpy, db };
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

/** Every folder below `base` for a list of (possibly nested) sub-folders, the intermediate ones included: "Assets/Images" is "Assets" and "Assets/Images". */
const treePaths = (base: string, subs: readonly string[]) => [...new Set(subs.flatMap((sub) => sub.split("/").map((_, i, parts) => `${base}/${parts.slice(0, i + 1).join("/")}`)))];
const ACME = `${LAYOUT.clients}/Acme Ltd (Primary Contact)`;
/** The folders in a client's tree: the 8 sub-folders plus the "Assets" level above the four Assets/* ones. */
const CLIENT_FOLDER_COUNT = treePaths("x", CLIENT_SUBFOLDERS).length;

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

  it("the drive_file_save subfolder enum is the drive's own names (client first, then product), with no numbered folder anywhere in the Drive tool text", () => {
    const subfolder = (DRIVE_TOOLS[2].parametersSchema as any).properties.subfolder;
    expect(subfolder.enum).toEqual([...DRIVE_SUBFOLDERS]);
    expect(subfolder.enum).toEqual(expect.arrayContaining(["Assets/Social", "Deliverables", "Contracts & Quotes", "Meetings & Notes", "Marketing assets/Images", "App store"]));
    for (const name of ["01 Briefs", "02 Assets", "03 Deliverables", "04 Reports", "05 Evidence", "99 Archive"]) expect(subfolder.enum).not.toContain(name);
    expect(subfolder.description).toContain("Assets/Images");
    expect(subfolder.description).toContain("Shared externally");
    expect(subfolder.description).toContain("invalid_subfolder");
    expect(JSON.stringify(DRIVE_TOOLS)).not.toMatch(/\b0\d [A-Z]|99 Archive/);
    // A client's project resolves to the client's folder: the agent is told so where it looks the folder up and where it makes it
    expect(DRIVE_TOOLS[0].description).toContain("client's folder");
    expect(DRIVE_TOOLS[1].description).toContain("client's folder");
  });

  it("(a) company-linked project idempotent: create then exists, nothing new in Drive; its folder is the company's", async () => {
    const st = seed();
    linked(st, "co-a", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.data?.status).toBe("created");
    expect(r1.data?.path).toBe(ACME);
    const files1 = google.files.length;
    expect(files1).toBeGreaterThan(0);
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("exists");
    expect(r2.data?.path).toBe(ACME);
    expect(r2.data?.folder_id).toBe(r1.data?.folder_id);
    expect(r2.data?.folder_id).toBe(folderOf(google.files, "crm_company", "co-a")!.id);
    expect(google.files.length).toBe(files1);
  });

  it("(a2) the hot paths do not read every contact link of the company: a repeat ensure (exists) and a resolve of a client's project need no contact lookup", async () => {
    const st = seed();
    linked(st, "co-a2", "Acme Ltd");
    const { harness, db } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(db.log.queries.some((q) => /contact_companies/.test(q.sql))).toBe(true); // planning the folder needs the contact's name
    db.log.queries.length = 0;
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("exists");
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("found");
    expect(db.log.queries.some((q) => /contact_companies/.test(q.sql))).toBe(false);
  });

  it("(b) unlinked project: its folder sits in Own projects, never at the Shared Drive root, with no company folder above it", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p-unlinked", companyId: CO, name: "Solo" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-unlinked" });
    expect(r.data?.path).toBe(`${LAYOUT.ownProjects}/Solo`);
    const project = folderOf(google.files, "project", "p-unlinked");
    const ownProjects = google.files.find((f) => f.name === "Own projects")!;
    expect(project).toMatchObject({ name: "Solo", parents: [ownProjects.id], description: `${LAYOUT.ownProjects}/Solo` });
    expect(anchorPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.ownProjects].sort());
    expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
    expect(google.files.some((f) => f.appProperties?.pibEntityType === "crm_company")).toBe(false);
  });

  it("(c) company-linked: company folder 'Acme Ltd (Primary Contact)' under Clients with the client sub-folders, and no folder for the project", async () => {
    const st = seed();
    linked(st, "co-c", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const companyFolder = folderOf(google.files, "crm_company", "co-c");
    const clients = google.files.find((f) => f.name === "Clients")!;
    expect(isAnchor(clients)).toBe(true);
    expect(companyFolder).toMatchObject({ name: "Acme Ltd (Primary Contact)", parents: [clients.id], description: ACME, appProperties: { pibComplete: "1" } });
    // No project folder of any kind: the company's folder is where the project's files go
    expect(folderOf(google.files, "project", "p1")).toBeUndefined();
    expect(google.files.some((f) => f.name === "Website")).toBe(false);
    for (const sub of CLIENT_SUBFOLDERS) expect(folderAt(google.files, `${ACME}/${sub}`)).toBeDefined();
    expect(userFolderPaths(google.files)).toHaveLength(1 + CLIENT_FOLDER_COUNT);
    expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
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
    // ...and the only thing made directly in the Shared Drive root is the top-level 02 Partners in Biz anchor.
    expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
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
    // The layout folders (02 Partners in Biz, Clients) and the company folder are created, then Google fails the first sub-folder.
    google.failNext({ method: "POST", skip: 3, status: 503 });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.error).toContain("retryable");
    expect(r1.error).toContain("Nothing was renamed or deleted");
    expect(folderPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.clients, ACME]);
    const companyId = folderOf(google.files, "crm_company", "co-g")!.id;
    // The half-built company folder is not complete yet, so a repeat resumes it instead of reporting "exists"
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("created");
    expect(r2.data?.folder_id).toBe(companyId);
    const paths = folderPaths(google.files);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(2 + 1 + CLIENT_FOLDER_COUNT); // two layout folders + company + its sub-folders
    expect(userFolderPaths(google.files)).toHaveLength(1 + CLIENT_FOLDER_COUNT);
    expect(google.files.filter((f) => f.name.startsWith("Acme Ltd"))).toHaveLength(1);
    expect(folderOf(google.files, "crm_company", "co-g")!.id).toBe(companyId);
    expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("exists");
  });

  it("(g2) a response lost after the folder was created is adopted on retry, not duplicated", async () => {
    const st = seed();
    linked(st, "co-g2", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    // Drive creates the company folder (after the two layout folders), then the answer is lost (a 502 on the way back).
    google.failNext({ method: "POST", skip: 2, status: 502, applyFirst: true });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.error).toContain("retryable");
    expect(folderPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.clients, ACME]);
    const lost = google.files.find((f) => f.name === "Acme Ltd (Primary Contact)")!;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    // Adopted, and the interrupted ensure is resumed: the sub-folders are made, not reported as "exists" with nothing in them.
    expect(r2.data?.status).toBe("created");
    expect(r2.data?.folder_id).toBe(lost.id);
    expect(treePaths(ACME, CLIENT_SUBFOLDERS).filter((path) => folderAt(google.files, path))).toHaveLength(CLIENT_FOLDER_COUNT);
    expect(google.files.filter((f) => isFolder(f) && f.parents.includes(lost.id)).map((f) => f.name).sort()).toEqual(["Assets", "Contracts & Quotes", "Deliverables", "Meetings & Notes", "Shared with client"]);
    expect(folderOf(google.files, "crm_company", "co-g2")).toMatchObject({ id: lost.id, appProperties: { pibComplete: "1" } });
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("exists");
    expect(google.files.filter((f) => f.name === "Acme Ltd (Primary Contact)")).toHaveLength(1);
    const paths = folderPaths(google.files);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("(g2b) a sub-folder whose creation answer was lost is adopted on retry, not made twice", async () => {
    const st = seed();
    linked(st, "co-g2b", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    // The first sub-folder ("Assets", the level above Assets/Images) is created and its answer lost
    google.failNext({ method: "POST", skip: 3, status: 502, applyFirst: true });
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).error).toContain("retryable");
    expect(folderPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.clients, ACME, `${ACME}/Assets`]);
    const lost = folderAt(google.files, `${ACME}/Assets`)!;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("created");
    expect(google.files.filter((f) => f.name === "Assets")).toHaveLength(1);
    expect(folderAt(google.files, `${ACME}/Assets/Images`)!.parents).toEqual([lost.id]);
    expect(userFolderPaths(google.files)).toHaveLength(1 + CLIENT_FOLDER_COUNT);
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
    expect(found.data?.path).toBe(`${LAYOUT.marketing}/PiB/Spring Launch`);
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "pm" })).data?.status).toBe("exists");
    expect(google.files.length).toBe(count);
  });

  it("(g4) the run that created a folder is recorded on it", async () => {
    const st = seed();
    linked(st, "co-g4", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(folderOf(google.files, "crm_company", "co-g4")?.appProperties?.pibRun).toBe("run-1");
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

  it("(h2) resolve of a client's project is the company's folder: not_found before, found after ensure, the same folder as resolving the company", async () => {
    const st = seed();
    linked(st, "co-h", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("not_found");
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "crm_company", entity_id: "co-h" })).data?.status).toBe("not_found");
    const made = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const viaProject = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    const viaCompany = await toolRaw(harness, "drive_folder_resolve", { entity_type: "crm_company", entity_id: "co-h" });
    const folder = folderOf(google.files, "crm_company", "co-h")!;
    expect(viaProject.data).toEqual({ status: "found", path: ACME, url: expect.stringContaining(folder.id), folder_id: folder.id });
    expect(viaCompany.data).toEqual(viaProject.data);
    expect(made.data?.folder_id).toBe(folder.id);
    // Read-only: resolving made nothing
    expect(google.calls.filter((c) => c.startsWith("POST") || c.startsWith("PATCH")).length).toBeGreaterThan(0);
    const writes = google.calls.filter((c) => c.startsWith("POST") || c.startsWith("PATCH")).length;
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(google.calls.filter((c) => c.startsWith("POST") || c.startsWith("PATCH")).length).toBe(writes);
  });

  it("(h3) a client project of a non-client kind resolves to its own branch folder, not to the company's", async () => {
    const st = seed();
    linked(st, "co-h3", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Widget" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: "co-h3" });
    await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind: "product" });
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("not_found");
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.path).toBe(`${LAYOUT.products}/Widget`);
    expect(r.data?.folder_id).toBe(folderOf(google.files, "project", "p1")!.id);
  });

  it("(h4) a project whose linked company record is gone has its own folder in Own projects, and resolve agrees with ensure", async () => {
    const st = seed();
    st.client_projects!.push({ id: "cp-gone", company_id: CO, project_id: "p1", client_kind: "company", client_ref: "co-deleted", created_at: "2026-01-01T00:00:00Z" });
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Orphan" } as never] });
    const made = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(made.data?.path).toBe(`${LAYOUT.ownProjects}/Orphan`);
    expect(made.data?.tree).toHaveLength(CLIENT_SUBFOLDERS.length);
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.folder_id).toBe(folderOf(google.files, "project", "p1")!.id);
    expect(google.files.some((f) => f.appProperties?.pibEntityType === "crm_company")).toBe(false);
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

  it("(l) two projects of one client share the client's folder (no collision); an unlinked project of the same name gets its own folder in Own projects", async () => {
    const st = seed();
    linked(st, "co-l", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.data?.status).toBe("created");
    const count = google.files.length;
    st.client_projects!.push({ id: "cp2", company_id: CO, project_id: "p2", client_kind: "company", client_ref: "co-l", created_at: "2026-01-01T00:00:00Z" });
    harness.seed({ projects: [{ id: "p2", companyId: CO, name: "Site" } as never] });
    // The very same name is no problem now: both projects are the company's folder
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });
    expect(r2.data?.status).toBe("exists");
    expect(r2.data?.folder_id).toBe(r1.data?.folder_id);
    expect(r2.data?.path).toBe(ACME);
    expect(google.files).toHaveLength(count);
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p2" })).data?.folder_id).toBe(r1.data?.folder_id);
    harness.seed({ projects: [{ id: "p3", companyId: CO, name: "Site" } as never] });
    const r3 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p3" });
    expect(r3.data?.status).toBe("created");
    // The unlinked "Site" is its own folder in Own projects; the client's folder is the company's.
    const ownProjects = google.files.find((f) => f.name === "Own projects")!;
    expect(folderOf(google.files, "project", "p3")).toMatchObject({ name: "Site", parents: [ownProjects.id] });
    expect(folderOf(google.files, "project", "p1")).toBeUndefined();
    expect(folderOf(google.files, "project", "p2")).toBeUndefined();
    expect(folderPaths(google.files)).toEqual(expect.arrayContaining([ACME, `${LAYOUT.ownProjects}/Site`]));
  });

  it("(l2) a client project's folder name is checked against the other companies' folders: a twin company is needs_human_look and nothing is created", async () => {
    const st = seed();
    linked(st, "co-l2", "Acme Ltd");
    st.companies!.push(company("co-twin", "acme  ltd"));
    st.contacts!.push(contact("con-twin", "Primary Contact"));
    st.contact_companies!.push({ id: "cc-twin", company_id: CO, contact_id: "con-twin", account_id: "co-twin", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("needs_human_look");
    expect(r.data?.conflictsWith).toEqual([{ entityType: "crm_company", entityId: "co-twin", name: "acme ltd (Primary Contact)" }]);
    expect(google.files).toHaveLength(0);
  });

  it("(l3) an invalid PROJECT name does not matter for a client's project (its folder is the company's), an invalid COMPANY name does", async () => {
    const st = seed();
    linked(st, "co-l3", "Acme Ltd");
    const { harness, google } = await setup(NATIVE, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "PAR-123" } as never] });
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data?.status).toBe("created");
    expect(folderOf(google.files, "crm_company", "co-l3")).toBeDefined();

    const bad = seed();
    linked(bad, "co-bad", "Acme/Co");
    const other = await setup(NATIVE, bad);
    other.harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    const r = await toolRaw(other.harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("invalid_name");
    expect(r.data?.name).toBe("Acme/Co (Primary Contact)");
    expect(r.data?.problem).toBe("illegal_chars");
    expect(other.google.files).toHaveLength(0);
  });

  it("(m) resolve returns the very folder ensure made, with a Drive link to it (an unlinked project: its own folder)", async () => {
    const { harness, google } = await setup();
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    const made = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    const folder = folderOf(google.files, "project", "p1")!;
    expect(r.data?.status).toBe("found");
    expect(r.data?.folder_id).toBe(folder.id);
    expect(made.data?.folder_id).toBe(folder.id);
    expect(r.data?.url).toContain(folder.id);
    expect(r.data?.path).toBe(`${LAYOUT.ownProjects}/P`);
  });

  it("(r) on a drive laid out like the real one, an existing client folder is adopted as the project's folder and nothing new is created", async () => {
    const st = seed();
    st.companies!.push(company("co-hg", "Hunt and Gun"));
    st.contacts!.push(contact("con-hg", "Christo Barnard"));
    st.contact_companies!.push({ id: "cc-hg", company_id: CO, contact_id: "con-hg", account_id: "co-hg", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    st.client_projects!.push({ id: "cp-hg", company_id: CO, project_id: "p-hg", client_kind: "company", client_ref: "co-hg", created_at: "2026-01-01T00:00:00Z" });
    st.client_projects!.push({ id: "cp-hg2", company_id: CO, project_id: "p-hg2", client_kind: "company", client_ref: "co-hg", created_at: "2026-01-02T00:00:00Z" });
    const google = fakeGoogle();
    const ids = seedPibDrive(google.files);
    const humanCount = google.files.length;
    const snapshot = new Map(google.files.map((f) => [f.id, JSON.stringify(f)]));
    const hg = SEEDED_CLIENT;
    const { harness } = await setup(NATIVE, st, google);
    harness.seed({ projects: [{ id: "p-hg", companyId: CO, name: "Hunt and Gun SEO" } as never, { id: "p-hg2", companyId: CO, name: "Hunt and Gun Social" } as never] });

    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-hg" });

    // The company's human-made folder IS the project's folder, adopted (tag + description) with nothing created beside it
    expect(r.data?.status).toBe("created");
    expect(r.data?.path).toBe(hg);
    expect(r.data?.folder_id).toBe(ids[hg]);
    expect(r.data?.url).toContain(ids[hg]!);
    const hgFolder = folderOf(google.files, "crm_company", "co-hg")!;
    expect(hgFolder.id).toBe(ids[hg]);
    expect(hgFolder).toMatchObject({ description: hg, appProperties: { pibEntityType: "crm_company", pibEntityId: "co-hg", pibComplete: "1" } });
    expect(folderOf(google.files, "project", "p-hg")).toBeUndefined();
    // Every sub-folder was found, none made: created false, the human-made ids
    expect(r.data?.tree.map((t: any) => [t.path, t.folderId, t.created])).toEqual(REAL_CLIENT_TREE.map((sub) => [`${hg}/${sub}`, ids[`${hg}/${sub}`], false]));
    expect(google.files).toHaveLength(humanCount);
    expect(google.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    // Every human-made folder and file is as it was (the adopted folder gained its tag)
    for (const [id, json] of snapshot) if (id !== ids[hg]) expect(JSON.stringify(google.files.find((f) => f.id === id))).toBe(json);
    expect(google.files.filter(isAnchor)).toHaveLength(0);
    expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib, LAYOUT.press].sort());
    const paths = folderPaths(google.files);
    expect(new Set(paths).size).toBe(paths.length);
    // The client's second project is the same folder; a repeat changes nothing
    const second = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-hg2" });
    expect(second.data?.status).toBe("exists");
    expect(second.data?.folder_id).toBe(ids[hg]);
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-hg" })).data?.status).toBe("exists");
    expect(google.files).toHaveLength(humanCount);
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
