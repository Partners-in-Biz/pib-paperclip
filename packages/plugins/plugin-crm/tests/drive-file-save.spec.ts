/**
 * drive_file_save and the drive.save-requested event on the drive's own folder layout (CRM 0.30.0), without Postgres:
 * the fake db behind the CRM harness, the real native broker, Google faked in memory. The same flows run on real Postgres in
 * drive-file-save.pg.spec.ts when embedded-postgres is installed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { CLIENT_SUBFOLDERS, LEGACY_SUBFOLDER_ALIASES, PRODUCT_SUBFOLDERS } from "../src/drive/convention.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { saveDriveFile } from "../src/drive/save.js";
import { DRIVE_ID, KEY_JSON, LAYOUT, SEEDED_CLIENT, fakeGoogle, folderAt, isFolder, seedPibDrive, uploadsOf } from "./support/fake-google-drive.js";

/** The bare event the kit's driveSave emits; the SDK's event type does not list it. */
const DRIVE_SAVE_REQUESTED = "drive.save-requested" as never;
const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };
const ACME = `${LAYOUT.clients}/Acme Ltd (Primary Contact)`;
const b64 = (text: string) => Buffer.from(text).toString("base64");
const save = (extra: Record<string, unknown> = {}) => ({ projectId: "p1", fileKind: "client", name: "2026-10-23 report v1.txt", mimeType: "text/plain", contentBase64: b64("report"), ...extra });

/** A client (Acme Ltd) with two linked projects (p1 and p2) on a bare Shared Drive, unless a prepared Google is passed. */
async function setup(google = fakeGoogle(), prepare?: (st: ReturnType<typeof seed>) => void) {
  const st = seed();
  st.companies!.push(company("co-a", "Acme Ltd"));
  st.contacts!.push(contact("contact-a", "Primary Contact"));
  st.contact_companies!.push({ id: "cc-a", company_id: CO, contact_id: "contact-a", account_id: "co-a", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  st.client_projects!.push({ id: "cp-1", company_id: CO, project_id: "p1", client_kind: "company", client_ref: "co-a", kind: "seo", created_at: "2026-01-01T00:00:00Z" });
  st.client_projects!.push({ id: "cp-2", company_id: CO, project_id: "p2", client_kind: "company", client_ref: "co-a", kind: "website", created_at: "2026-01-02T00:00:00Z" });
  prepare?.(st);
  const { harness, store, emit } = await boot({ config: NATIVE, store: st });
  harness.seed({ projects: [
    { id: "p1", companyId: CO, name: "Acme SEO" } as never,
    { id: "p2", companyId: CO, name: "Acme Website" } as never,
    { id: "p-own", companyId: CO, name: "Own Work" } as never,
    { id: "p-prod", companyId: CO, name: "Widget" } as never,
    { id: "p-book", companyId: CO, name: "Cool Book" } as never,
    { id: "p-int", companyId: CO, name: "Ops" } as never,
    { id: "p-mkt", companyId: CO, name: "Spring Launch" } as never,
  ] });
  vi.stubGlobal("fetch", google.fetchFn);
  const kind = async (projectId: string, k: string) => expect((await toolRaw(harness, "drive_project_kind_set", { projectId, kind: k })).data?.status).toBe("set");
  /** The stored drive_files rows (the fake db's table) */
  const rows = () => (store.drive_files ?? []) as Array<Record<string, any>>;
  /** The replies the CRM emitted for drive.save-requested events */
  const replies = () => emit.mock.calls.filter((call) => /drive\.file\.(saved|failed)$/.test(String(call[0]))).map((call) => ({ type: String(call[0]).split(".").slice(-1)[0], payload: call[2] as Record<string, any> }));
  /** The save function itself (what the drive.save-requested handler calls): no tool schema in front of it, so it also sees names the schema enum would refuse. */
  const saveDirect = (extra: Record<string, unknown> = {}) => saveDriveFile(harness.ctx, { companyId: CO, userId: null, agentId: null, role: null }, { companyId: CO, ...save(extra) } as never);
  return { harness, google, store, kind, rows, replies, saveDirect };
}

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("drive_file_save into a client's folder", () => {
  it("(d) subfolder 'Assets/Social' lands in that folder of the client, and the stored row keeps the sub-folder and the folder id", async () => {
    const { harness, google, rows } = await setup();
    const r = await toolRaw(harness, "drive_file_save", save({ subfolder: "Assets/Social" }));

    expect(r.data).toMatchObject({ status: "saved", subfolder: "Assets/Social", duplicate: false });
    const social = folderAt(google.files, `${ACME}/Assets/Social`)!;
    const uploads = uploadsOf(google.files);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ name: "2026-10-23 report v1.txt", parents: [social.id] });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ project_id: "p1", folder_id: social.id, subfolder: "Assets/Social" });
    // No project folder was made: the client's folder holds everything
    expect(google.files.some((f) => f.name === "Acme SEO")).toBe(false);
  });

  it.each([...CLIENT_SUBFOLDERS])("every client sub-folder is reachable by its exact path: '%s'", async (subfolder) => {
    const { harness, google } = await setup();
    const r = await toolRaw(harness, "drive_file_save", save({ subfolder }));
    expect(r.data?.status).toBe("saved");
    expect(r.data?.subfolder).toBe(subfolder);
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${ACME}/${subfolder}`)!.id]);
  });

  it("no subfolder: the file goes into the client's folder itself, stored with no sub-folder", async () => {
    const { harness, google, rows } = await setup();
    const r = await toolRaw(harness, "drive_file_save", save());
    expect(r.data).toMatchObject({ status: "saved", subfolder: null });
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, ACME)!.id]);
    expect(rows()[0]!.subfolder).toBeNull();
  });

  it("a sub-folder asked of an already-made client folder is found in the tree (no new folder); the same file again is a duplicate", async () => {
    const { harness, google } = await setup();
    await toolRaw(harness, "drive_file_save", save({ name: "2026-10-23 first v1.txt" }));
    const folders = google.files.filter(isFolder).length;
    const r = await toolRaw(harness, "drive_file_save", save({ subfolder: "Deliverables" }));
    expect(r.data?.status).toBe("saved");
    expect(uploadsOf(google.files)[1]!.parents).toEqual([folderAt(google.files, `${ACME}/Deliverables`)!.id]);
    expect(google.files.filter(isFolder)).toHaveLength(folders);
    const again = await toolRaw(harness, "drive_file_save", save({ subfolder: "Deliverables" }));
    expect(again.data).toMatchObject({ status: "saved", duplicate: true, driveFileId: r.data?.driveFileId });
    expect(uploadsOf(google.files)).toHaveLength(2);
  });

  it("two projects of one client save into the same folder (the stored rows keep their own project)", async () => {
    const { harness, google, rows } = await setup();
    await toolRaw(harness, "drive_file_save", save({ projectId: "p1", name: "2026-10-23 seo v1.txt", subfolder: "Deliverables" }));
    await toolRaw(harness, "drive_file_save", save({ projectId: "p2", name: "2026-10-23 web v1.txt", subfolder: "Deliverables" }));
    const deliverables = folderAt(google.files, `${ACME}/Deliverables`)!;
    expect(uploadsOf(google.files).map((f) => f.parents[0])).toEqual([deliverables.id, deliverables.id]);
    expect(rows().map((row) => [row.project_id, row.folder_id])).toEqual([["p1", deliverables.id], ["p2", deliverables.id]]);
    expect(google.files.filter((f) => f.name === "Deliverables")).toHaveLength(1);
  });

  it("a sub-folder name is matched by its exact path: 'Brand' (a product folder) is refused for a client, whose folder has Assets/Brand", async () => {
    const { harness, google } = await setup();
    const r = await toolRaw(harness, "drive_file_save", save({ subfolder: "Brand" }));
    expect(r.data?.status).toBe("invalid_subfolder");
    expect(r.data?.hint).toContain(`"Brand"`);
    for (const option of CLIENT_SUBFOLDERS) expect(r.data?.hint).toContain(option);
    expect(r.data?.hint).not.toContain("App store");
    expect(uploadsOf(google.files)).toHaveLength(0);
  });

  it.each(["Nope", "Assets", "Images", "assets/social", "Assets/Social/", "99 Archive", "../Deliverables"])("an unknown sub-folder '%s' is invalid_subfolder before any Google call", async (subfolder) => {
    const { google, rows, saveDirect } = await setup();
    const r = await saveDirect({ subfolder });
    expect(r.status).toBe("invalid_subfolder");
    expect(r.hint).toContain("must be one of");
    expect(r.hint).toContain("Assets/Images");
    expect(r.hint).toContain("Shared externally");
    expect(google.calls).toHaveLength(0);
    expect(uploadsOf(google.files)).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("a blank sub-folder is invalid_subfolder too (an empty one means no sub-folder)", async () => {
    const { google, saveDirect } = await setup();
    expect((await saveDirect({ subfolder: "   " })).status).toBe("invalid_subfolder");
    expect(google.calls).toHaveLength(0);
    expect((await saveDirect({ subfolder: "" })).status).toBe("saved");
  });
});

describe("the old numbered sub-folder names are aliases", () => {
  it.each(Object.entries(LEGACY_SUBFOLDER_ALIASES))("(e) '%s' lands in %s and is stored with the new name", async (legacy, current) => {
    const { google, rows, saveDirect } = await setup();
    const r = await saveDirect({ subfolder: legacy });
    expect(r).toMatchObject({ status: "saved", subfolder: current });
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${ACME}/${current}`)!.id]);
    expect(rows()[0]!.subfolder).toBe(current);
    // The old name is not made as a folder
    expect(google.files.some((f) => f.name === legacy)).toBe(false);
  });

  it("(e) '99 Archive' has no alias: invalid_subfolder, nothing saved, no Google call", async () => {
    const { google, saveDirect } = await setup();
    const r = await saveDirect({ subfolder: "99 Archive" });
    expect(r.status).toBe("invalid_subfolder");
    expect(google.calls).toHaveLength(0);
    expect(uploadsOf(google.files)).toHaveLength(0);
  });

  it("(e) a producer's drive.save-requested event with '02 Assets' lands in Assets/Social, with '04 Reports' in Deliverables; the CRM answers drive.file.saved", async () => {
    const { harness, google, rows, replies } = await setup();
    const event = (requestId: string, name: string, subfolder: string) =>
      harness.emit(DRIVE_SAVE_REQUESTED, { requestId, kind: "social", name, mimeType: "text/plain", contentBase64: b64(name), subfolder, clientKind: "company", clientRef: "co-a" }, { companyId: CO });

    await event("req1", "2026-10-23 social v1.txt", "02 Assets");
    await event("req2", "2026-10-23 report v1.txt", "04 Reports");
    await event("req3", "2026-10-23 notes v1.txt", "01 Briefs");

    expect(replies().map((reply) => [reply.type, reply.payload.requestId])).toEqual([["saved", "req1"], ["saved", "req2"], ["saved", "req3"]]);
    const parentOf = (name: string) => uploadsOf(google.files).find((f) => f.name === name)!.parents[0];
    expect(parentOf("2026-10-23 social v1.txt")).toBe(folderAt(google.files, `${ACME}/Assets/Social`)!.id);
    expect(parentOf("2026-10-23 report v1.txt")).toBe(folderAt(google.files, `${ACME}/Deliverables`)!.id);
    expect(parentOf("2026-10-23 notes v1.txt")).toBe(folderAt(google.files, `${ACME}/Meetings & Notes`)!.id);
    expect(rows().map((row) => row.subfolder)).toEqual(["Assets/Social", "Deliverables", "Meetings & Notes"]);
    // The event saved into the client's one folder: no project folder, no numbered folder
    expect(google.files.some((f) => /^\d\d /.test(f.name) && f.name !== LAYOUT.pib)).toBe(false);
  });

  it("(e) an event with a sub-folder that cannot be translated is answered drive.file.failed with the reason, and nothing is saved", async () => {
    const { harness, google, replies } = await setup();
    await harness.emit(DRIVE_SAVE_REQUESTED, { requestId: "req9", kind: "ops", name: "2026-10-23 old v1.txt", mimeType: "text/plain", contentBase64: b64("old"), subfolder: "99 Archive", clientKind: "company", clientRef: "co-a" }, { companyId: CO });
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toMatchObject({ type: "failed", payload: { requestId: "req9", reason: "invalid_subfolder" } });
    expect(replies()[0]!.payload.hint).toContain("must be one of");
    expect(uploadsOf(google.files)).toHaveLength(0);
  });
});

describe("drive_file_save into a product's folder", () => {
  it("(f) a product saves 'Marketing assets/Images' into Products/<Product>/Marketing assets/Images; 'Deliverables' is invalid_subfolder with the folder's real options", async () => {
    const { harness, google, kind, rows } = await setup();
    await kind("p-prod", "product");
    const ok = await toolRaw(harness, "drive_file_save", save({ projectId: "p-prod", subfolder: "Marketing assets/Images" }));
    expect(ok.data).toMatchObject({ status: "saved", subfolder: "Marketing assets/Images" });
    const images = folderAt(google.files, `${LAYOUT.products}/Widget/Marketing assets/Images`)!;
    expect(uploadsOf(google.files)[0]!.parents).toEqual([images.id]);
    expect(rows()[0]).toMatchObject({ project_id: "p-prod", folder_id: images.id, subfolder: "Marketing assets/Images" });

    const bad = await toolRaw(harness, "drive_file_save", save({ projectId: "p-prod", name: "2026-10-23 other v1.txt", subfolder: "Deliverables" }));
    expect(bad.data?.status).toBe("invalid_subfolder");
    // The hint lists what the product folder really has
    for (const option of PRODUCT_SUBFOLDERS) expect(bad.data?.hint).toContain(option);
    expect(bad.data?.hint).not.toContain("Contracts & Quotes");
    expect(uploadsOf(google.files)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    // A name only the client folder has is refused for a product too (exact path, no last-segment match)
    expect((await toolRaw(harness, "drive_file_save", save({ projectId: "p-prod", name: "2026-10-23 third v1.txt", subfolder: "Assets/Social" }))).data?.status).toBe("invalid_subfolder");
  });

  it.each([...PRODUCT_SUBFOLDERS])("every product sub-folder is reachable by its exact path: '%s'", async (subfolder) => {
    const { harness, google, kind } = await setup();
    await kind("p-prod", "product");
    const r = await toolRaw(harness, "drive_file_save", save({ projectId: "p-prod", subfolder }));
    expect(r.data?.status).toBe("saved");
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${LAYOUT.products}/Widget/${subfolder}`)!.id]);
  });

  it("a legacy alias that maps to a client-only name ('04 Reports' -> Deliverables) is invalid_subfolder for a product, with its options", async () => {
    const { google, kind, saveDirect } = await setup();
    await kind("p-prod", "product");
    const r = await saveDirect({ projectId: "p-prod", subfolder: "04 Reports" });
    expect(r.status).toBe("invalid_subfolder");
    expect(r.hint).toContain('"Deliverables"');
    expect(r.hint).toContain("Design");
    expect(uploadsOf(google.files)).toHaveLength(0);
  });
});

describe("folders with no standard sub-folders (book, company area, marketing)", () => {
  it.each([
    ["book", "p-book", `${LAYOUT.books}/Cool Book`],
    ["company", "p-int", `${LAYOUT.internal}/Ops`],
    ["marketing", "p-mkt", `${LAYOUT.marketing}/PiB/Spring Launch`],
  ])("(g) a %s folder has no sub-folders, and a save that names one lands in the folder itself", async (k, projectId, folderPath) => {
    const { harness, google, kind, rows, saveDirect } = await setup();
    await kind(projectId, k);
    const ensured = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: projectId });
    expect(ensured.data).toMatchObject({ status: "created", path: folderPath, tree: [] });
    const folder = folderAt(google.files, folderPath)!;
    expect(google.files.filter((f) => isFolder(f) && f.parents.includes(folder.id))).toEqual([]);

    // A current name, an old numbered name: both are ignored, the file is in the folder itself, stored with no sub-folder
    const first = await toolRaw(harness, "drive_file_save", save({ projectId, name: "2026-10-23 one v1.txt", subfolder: "Deliverables" }));
    const second = await saveDirect({ projectId, name: "2026-10-23 two v1.txt", subfolder: "04 Reports" });
    expect(first.data).toMatchObject({ status: "saved", subfolder: null });
    expect(second).toMatchObject({ status: "saved", subfolder: null });
    expect(uploadsOf(google.files).map((f) => f.parents[0])).toEqual([folder.id, folder.id]);
    expect(rows().map((row) => [row.folder_id, row.subfolder])).toEqual([[folder.id, null], [folder.id, null]]);
    // Still no sub-folder anywhere below it
    expect(google.files.filter((f) => isFolder(f) && f.parents.includes(folder.id))).toEqual([]);
  });

  it("(g) a save that names a sub-folder first, before the folder was ever ensured, builds the folder and still lands in it", async () => {
    const { harness, google, kind } = await setup();
    await kind("p-book", "book");
    const r = await toolRaw(harness, "drive_file_save", save({ projectId: "p-book", subfolder: "Assets/Social" }));
    expect(r.data).toMatchObject({ status: "saved", subfolder: null });
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${LAYOUT.books}/Cool Book`)!.id]);
  });
});

describe("an unlinked project (Own projects)", () => {
  it("keeps its own folder in Own projects with the client sub-folders; sub-folder saves land there", async () => {
    const { harness, google } = await setup();
    const r = await toolRaw(harness, "drive_file_save", save({ projectId: "p-own", subfolder: "Meetings & Notes" }));
    expect(r.data).toMatchObject({ status: "saved", subfolder: "Meetings & Notes" });
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${LAYOUT.ownProjects}/Own Work/Meetings & Notes`)!.id]);
  });
});

describe("a client folder made before 0.30.0", () => {
  it("(s) was registered complete with no sub-folders: ensure reports exists (empty tree), and the first save that names a sub-folder builds it", async () => {
    const google = fakeGoogle();
    // What the 0.29 broker left behind for the company: tagged and complete, with no sub-folders
    google.files.push({ id: "pib", name: LAYOUT.pib, mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_ID] });
    google.files.push({ id: "clients", name: "Clients", mimeType: "application/vnd.google-apps.folder", parents: ["pib"] });
    google.files.push({ id: "old-co", name: "Acme Ltd (Primary Contact)", mimeType: "application/vnd.google-apps.folder", parents: ["clients"], description: ACME, appProperties: { pibEntityType: "crm_company", pibEntityId: "co-a", pibComplete: "1" } });
    google.files.push({ id: "old-p", name: "Acme SEO", mimeType: "application/vnd.google-apps.folder", parents: ["old-co"], description: `${ACME}/Acme SEO`, appProperties: { pibEntityType: "project", pibEntityId: "p1", pibComplete: "1" } });
    google.files.push({ id: "old-b", name: "01 Briefs", mimeType: "application/vnd.google-apps.folder", parents: ["old-p"] });
    const { harness } = await setup(google);

    const ensured = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(ensured.data).toMatchObject({ status: "exists", folder_id: "old-co", path: ACME, tree: [] });
    expect(google.files.some((f) => f.name === "Deliverables")).toBe(false);

    const r = await toolRaw(harness, "drive_file_save", save({ subfolder: "Deliverables" }));
    expect(r.data).toMatchObject({ status: "saved", subfolder: "Deliverables" });
    expect(uploadsOf(google.files)[0]!.parents).toEqual([folderAt(google.files, `${ACME}/Deliverables`)!.id]);
    // The old project folder and its numbered folder are left exactly where they were, unused
    expect(google.files.find((f) => f.id === "old-p")).toMatchObject({ name: "Acme SEO", parents: ["old-co"] });
    expect(google.files.find((f) => f.id === "old-b")).toMatchObject({ name: "01 Briefs", parents: ["old-p"] });
    // The company folder is complete now with its sub-folders
    expect((await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" })).data).toMatchObject({ status: "exists", folder_id: "old-co" });
  });
});

describe("on a drive laid out like the real one", () => {
  it("(d) a save into Assets/Social of the human-made client folder lands in the human-made folder, and nothing is created", async () => {
    const google = fakeGoogle();
    const ids = seedPibDrive(google.files);
    const humanCount = google.files.length;
    const { harness } = await setup(google, (st) => {
      st.companies!.push(company("co-hg", "Hunt and Gun"));
      st.contacts!.push(contact("con-hg", "Christo Barnard"));
      st.contact_companies!.push({ id: "cc-hg", company_id: CO, contact_id: "con-hg", account_id: "co-hg", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
      st.client_projects!.push({ id: "cp-hg", company_id: CO, project_id: "p-hg", client_kind: "company", client_ref: "co-hg", created_at: "2026-01-01T00:00:00Z" });
    });
    harness.seed({ projects: [{ id: "p-hg", companyId: CO, name: "Hunt and Gun SEO" } as never] });

    const r = await toolRaw(harness, "drive_file_save", save({ projectId: "p-hg", fileKind: "seo", subfolder: "02 Assets" }));

    expect(r.data).toMatchObject({ status: "saved", subfolder: "Assets/Social" });
    const uploads = uploadsOf(google.files).filter((f) => !f.id.startsWith("human-"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.parents).toEqual([ids[`${SEEDED_CLIENT}/Assets/Social`]]);
    // Only the upload is new: no folder of any kind was created
    expect(google.files).toHaveLength(humanCount + 1);
    expect(google.calls.filter((c) => c.startsWith("POST")).every((c) => c.includes("/upload/"))).toBe(true);
  });
});
