import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { BrokerError, DriveNotBoundError, type Broker, type EnsureResult } from "../src/drive/broker.js";
import { clearServiceAccountTokenCache, parseServiceAccountKey } from "../src/drive/google-sa.js";
import { planFolders, DRIVE_SUBFOLDERS, type DriveFacts } from "../src/drive/convention.js";

import { DRIVE_ID, KEY_JSON, LAYOUT, anchorPaths, fakeGoogle, folderPaths, isAnchor, isFolder, rootFolderNames, seedPibDrive, userFolderPaths, userFolders } from "./support/fake-google-drive.js";

const broker = (g: ReturnType<typeof fakeGoogle>) => createGoogleDriveBroker(g.fetchFn, parseServiceAccountKey(KEY_JSON), DRIVE_ID);

beforeEach(() => clearServiceAccountTokenCache());

describe("createGoogleDriveBroker", () => {
  it("refuses to start without a Shared Drive", () => {
    expect(() => createGoogleDriveBroker(fakeGoogle().fetchFn, parseServiceAccountKey(KEY_JSON), " ")).toThrow(DriveNotBoundError);
  });

  it("ensures the company → project tree with numbered sub-folders, and resolve finds it", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    const company = await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(company.created).toBe(true);
    expect(company.folder.path).toBe(`${LAYOUT.clients}/Acme`);
    const project = await b.ensure({ entity_type: "project", entity_id: "p1", name: "Acme Website", parent_entity_id: "co1", subfolders: [...DRIVE_SUBFOLDERS] });
    expect(project.created).toBe(true);
    expect(project.folder.path).toBe(`${LAYOUT.clients}/Acme/Acme Website`);
    expect(project.tree.map((t) => t.path)).toEqual(DRIVE_SUBFOLDERS.map((s) => `${LAYOUT.clients}/Acme/Acme Website/${s}`));
    expect(project.tree.every((t) => t.created)).toBe(true);

    const found = await b.resolve("project", "p1");
    expect(found?.folder_id).toBe(project.folder.folder_id);
    expect(found?.path).toBe(`${LAYOUT.clients}/Acme/Acme Website`);
    expect(await b.resolve("project", "nope")).toBeNull();
    // The two layout folders were made once, tagged as anchors, and the company is a plain child of Clients.
    expect(anchorPaths(g.files)).toEqual([LAYOUT.pib, LAYOUT.clients]);
    expect(userFolderPaths(g.files)).toEqual([`${LAYOUT.clients}/Acme`, `${LAYOUT.clients}/Acme/Acme Website`, ...DRIVE_SUBFOLDERS.map((s) => `${LAYOUT.clients}/Acme/Acme Website/${s}`)].sort());
  });

  it("ensure is idempotent: a repeat creates nothing and returns the same tree ids", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    const first = await b.ensure({ entity_type: "project", entity_id: "p1", name: "Site", parent_entity_id: "co1", subfolders: ["01 Briefs", "02 Assets"] });
    const count = g.files.length;
    const second = await b.ensure({ entity_type: "project", entity_id: "p1", name: "Site", parent_entity_id: "co1", subfolders: ["01 Briefs", "02 Assets"] });
    expect(g.files.length).toBe(count);
    expect(second.created).toBe(false);
    expect(second.tree.map((t) => [t.folderId, t.created])).toEqual(first.tree.map((t) => [t.folderId, false]));
  });

  it("builds the planFolders steps end to end (root branch and client branch)", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    const plan = planFolders({ entityType: "project", entityId: "pb", name: "Cool Book", branch: "book" }, []);
    if (plan.kind !== "ensure") throw new Error("plan");
    let last;
    for (const step of plan.steps) last = await b.ensure(step);
    expect(last!.folder.path).toBe(`${LAYOUT.books}/Cool Book`);
    expect(last!.tree).toHaveLength(DRIVE_SUBFOLDERS.length);

    const client = planFolders({ entityType: "project", entityId: "pc", name: "Site", companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" }, []);
    if (client.kind !== "ensure") throw new Error("plan");
    for (const step of client.steps) last = await b.ensure(step);
    expect(last!.folder.path).toBe(`${LAYOUT.clients}/Acme Ltd (John Doe)/Site`);
    expect(last!.tree).toHaveLength(DRIVE_SUBFOLDERS.length);
  });

  it("adopts a same-named untagged folder (made by the old broker or by hand) instead of duplicating", async () => {
    const g = fakeGoogle();
    const ids = seedPibDrive(g.files);
    const before = g.files.length;
    g.files.push({ id: "old1", name: "Acme", mimeType: "application/vnd.google-apps.folder", parents: [ids[LAYOUT.clients]!] });
    const r = await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(r.created).toBe(false);
    expect(r.folder.folder_id).toBe("old1");
    expect(g.files).toHaveLength(before + 1);
    expect((await broker(g).resolve("crm_company", "co1"))?.folder_id).toBe("old1");
  });

  it("back-fills the complete tag on a folder made before the tag existed (no sub-folders to wait for); a registered folder is found by its tag wherever it sits", async () => {
    const g = fakeGoogle();
    g.files.push({ id: "old2", name: "Acme", mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_ID], description: "Acme", appProperties: { pibEntityType: "crm_company", pibEntityId: "co1" } });
    const b = broker(g);
    expect((await b.resolve("crm_company", "co1"))?.complete).toBe(false);
    const r = await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(r.created).toBe(false);
    expect(r.folder.complete).toBe(true);
    expect(g.files.find((f) => f.id === "old2")?.appProperties?.pibComplete).toBe("1");
    expect((await b.resolve("crm_company", "co1"))?.complete).toBe(true);
  });

  it("refuses a same-named folder that already belongs to another entity (409, not retryable)", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    await expect(b.ensure({ entity_type: "crm_company", entity_id: "co2", name: "Acme" })).rejects.toMatchObject({ status: 409, retryable: false });
  });

  it("refuses a project whose parent is not registered", async () => {
    const g = fakeGoogle();
    await expect(broker(g).ensure({ entity_type: "project", entity_id: "p1", name: "Site", parent_entity_id: "missing" })).rejects.toMatchObject({ code: "parent_missing", status: 409 });
  });

  it("uploads bytes intact with the sha256 recorded, and a repeat is deduplicated", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    const folder = await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    const bytes = randomBytes(300_000);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const first = await b.uploadFile({ name: "2026-10-23 report v1.pdf", bytes, mimeType: "application/pdf", parentFolderId: folder.folder.folder_id });
    expect(first).toMatchObject({ sha256: sha, deduplicated: false, size: 300_000, parentFolderId: folder.folder.folder_id });
    expect(first.webViewLink).toContain("drive.google.com");
    expect(g.files.find((f) => f.id === first.fileId)?.appProperties?.pibSha256).toBe(sha);
    const again = await b.uploadFile({ name: "2026-10-23 report v1.pdf", bytes, mimeType: "application/pdf", parentFolderId: folder.folder.folder_id });
    expect(again.deduplicated).toBe(true);
    expect(again.fileId).toBe(first.fileId);
    expect(g.files.filter((f) => !f.mimeType.includes("folder"))).toHaveLength(1);
  });

  it("rejects files over 5 MiB before any Google call", async () => {
    const g = fakeGoogle();
    await expect(broker(g).uploadFile({ name: "big.bin", bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: "application/octet-stream" })).rejects.toMatchObject({ code: "too_large", status: 413 });
    expect(g.calls).toHaveLength(0);
  });

  it("every Drive call carries supportsAllDrives=true", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme", subfolders: ["01 Briefs"] });
    await b.resolve("crm_company", "co1");
    await b.uploadFile({ name: "a.txt", bytes: new Uint8Array([1, 2, 3]), mimeType: "text/plain" });
    await b.identity();
    expect(g.calls.length).toBeGreaterThan(5);
    expect(g.calls.every((c) => c.includes("supportsAllDrives=true"))).toBe(true);
  });

  it("identity: member → isMember true; not a member → isMember false with the service account email", async () => {
    expect(await broker(fakeGoogle({ member: true })).identity()).toEqual({ serviceAccountEmail: "drive-sa@proj.iam.gserviceaccount.com", isMember: true });
    expect(await broker(fakeGoogle({ member: false })).identity()).toEqual({ serviceAccountEmail: "drive-sa@proj.iam.gserviceaccount.com", isMember: false });
  });

  it("maps a 403 on a folder call to a not-a-member error that names the fix, not retryable", async () => {
    const err = await broker(fakeGoogle({ filesStatus: 403 })).resolve("project", "p1").catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ status: 403, retryable: false, code: "not_member" });
    expect(err.message).toMatch(/Content manager/);
  });

  it("marks Google 5xx retryable and a refused key as a bad credential", async () => {
    expect(await broker(fakeGoogle({ filesStatus: 500 })).resolve("project", "p1").catch((e) => e)).toMatchObject({ status: 500, retryable: true });
    clearServiceAccountTokenCache();
    expect(await broker(fakeGoogle({ tokenStatus: 400 })).resolve("project", "p1").catch((e) => e)).toMatchObject({ code: "bad_credential", retryable: false });
  });
});

/** Runs every step of a plan, as the tool layer does, and returns the leaf. */
async function runPlan(b: Broker, facts: DriveFacts): Promise<EnsureResult> {
  const plan = planFolders(facts, []);
  if (plan.kind !== "ensure") throw new Error(`plan: ${plan.kind}`);
  let last: EnsureResult | undefined;
  for (const step of plan.steps) last = await b.ensure(step);
  return last!;
}

describe("Shared Drive layout: never the Drive root", () => {
  const HG = `${LAYOUT.clients}/Hunt and Gun (Christo Barnard)`;
  const hgFacts: DriveFacts = { entityType: "project", entityId: "p-hg", name: "Hunt and Gun SEO", companyEntityId: "co-hg", companyName: "Hunt and Gun", contactName: "Christo Barnard" };

  it("a client chain on a bare drive creates nothing at the root but 02 Partners in Biz, and the layout folders are tagged anchors made once", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    const leaf = await runPlan(b, { ...hgFacts, companyName: "Acme Ltd", contactName: "Primary Contact" });
    expect(leaf.folder.path).toBe(`${LAYOUT.clients}/Acme Ltd (Primary Contact)/Hunt and Gun SEO`);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib]);
    expect(anchorPaths(g.files)).toEqual([LAYOUT.pib, LAYOUT.clients]);
    expect(g.files.filter(isAnchor).map((f) => f.description).sort()).toEqual([LAYOUT.pib, LAYOUT.clients].sort());
    // A second client shares the same Clients folder: still one of each anchor.
    await runPlan(b, { ...hgFacts, entityId: "p-2", companyEntityId: "co-2", companyName: "Globex", contactName: "Jo" });
    await runPlan(broker(g), { ...hgFacts, entityId: "p-3", companyEntityId: "co-3", companyName: "Initech", contactName: "Bill" });
    expect(anchorPaths(g.files)).toEqual([LAYOUT.pib, LAYOUT.clients]);
    expect(g.files.filter((f) => f.name === "Clients")).toHaveLength(1);
    expect(g.files.filter((f) => f.name === LAYOUT.pib)).toHaveLength(1);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib]);
  });

  type Case = [label: string, facts: DriveFacts, leafPath: string, rootNames: string[]];
  const widget = (extra: Partial<DriveFacts>): DriveFacts => ({ entityType: "project", entityId: "p1", name: "Widget", ...extra });
  const cases: Case[] = [
    ["a client project", widget({ companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" }), `${LAYOUT.clients}/Acme Ltd (John Doe)/Widget`, [LAYOUT.pib]],
    ["a project with no client and no kind", widget({}), `${LAYOUT.ownProjects}/Widget`, [LAYOUT.pib]],
    ["a product", widget({ branch: "product" }), `${LAYOUT.products}/Widget`, [LAYOUT.pib]],
    ["a company (internal) project", widget({ branch: "company" }), `${LAYOUT.internal}/Widget`, [LAYOUT.pib]],
    ["a marketing campaign with the default scope", widget({ branch: "marketing" }), `${LAYOUT.marketing}/PiB/Widget`, [LAYOUT.pib]],
    ["a marketing campaign with its own scope", widget({ branch: "marketing", scopeRef: "Acme Launch" }), `${LAYOUT.marketing}/Acme Launch/Widget`, [LAYOUT.pib]],
    ["a book", widget({ branch: "book" }), `${LAYOUT.books}/Widget`, [LAYOUT.press]],
  ];
  it.each(cases)("on a bare drive %s lands at its fixed path with the numbered sub-folders, and nothing else is created at the root", async (_label, facts, leafPath, rootNames) => {
    const g = fakeGoogle();
    const leaf = await runPlan(broker(g), facts);
    expect(leaf.folder.path).toBe(leafPath);
    expect(leaf.tree.map((t) => t.path)).toEqual(DRIVE_SUBFOLDERS.map((sub) => `${leafPath}/${sub}`));
    expect(rootFolderNames(g.files)).toEqual(rootNames);
    // Nothing was created at the root and no folder is duplicated.
    const paths = folderPaths(g.files);
    expect(new Set(paths).size).toBe(paths.length);
    expect(g.files.every((f) => !f.parents.includes(DRIVE_ID) || rootNames.includes(f.name))).toBe(true);
  });

  it("a fixed root is the existing folder at its path, never a new entity folder: created false, no tree, the same folder on a repeat", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    const first = await b.ensure({ entity_type: "root", entity_id: "root:products", name: "Products" });
    expect(first).toMatchObject({ created: false, tree: [], folder: { path: LAYOUT.products, entity_type: "root", entity_id: "root:products", complete: true } });
    expect(anchorPaths(g.files)).toEqual([LAYOUT.pib, LAYOUT.products]);
    expect(userFolders(g.files)).toHaveLength(0);
    const count = g.files.length;
    const again = await broker(g).ensure({ entity_type: "root", entity_id: "root:products", name: "Products" });
    expect(again.folder.folder_id).toBe(first.folder.folder_id);
    expect(g.files).toHaveLength(count);
    const books = await b.ensure({ entity_type: "root", entity_id: "root:books", name: "Books" });
    expect(books.folder.path).toBe(LAYOUT.books);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib, LAYOUT.press].sort());
  });

  it("resolve of a fixed root is null on a bare drive and writes nothing; after a product ensure it is the Products anchor folder", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    expect(await b.resolve("root", "root:products")).toBeNull();
    expect(await b.resolve("root", "root:books")).toBeNull();
    expect(await b.resolve("root", "root:company")).toBeNull();
    expect(await b.resolve("root", "root:marketing")).toBeNull();
    expect(g.files).toHaveLength(0);
    expect(g.calls.every((c) => c.startsWith("GET"))).toBe(true);

    const leaf = await runPlan(b, { entityType: "project", entityId: "pp", name: "Widget", branch: "product" });
    const anchor = g.files.find((f) => f.name === "Products")!;
    expect(isAnchor(anchor)).toBe(true);
    for (const reader of [b, broker(g)]) {
      const found = await reader.resolve("root", "root:products");
      expect(found).toMatchObject({ folder_id: anchor.id, path: LAYOUT.products, entity_type: "root", entity_id: "root:products", complete: true });
      expect(found?.folder_url).toContain(anchor.id);
    }
    expect(leaf.folder.path).toBe(`${LAYOUT.products}/Widget`);
    // The other fixed roots stay unresolved: nothing made them.
    expect(await b.resolve("root", "root:books")).toBeNull();
    expect(await b.resolve("root", "root:company")).toBeNull();
    // An unknown root id is not an anchor and is not on the drive.
    expect(await b.resolve("root", "root:nowhere")).toBeNull();
  });

  it("resolve of the marketing scope folder is the normal registered child of Marketing & Sales", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    await runPlan(b, { entityType: "project", entityId: "pm", name: "Spring Launch", branch: "marketing", scopeRef: "PiB" });
    const scope = await b.resolve("root", "root:marketing:pib");
    expect(scope).toMatchObject({ path: `${LAYOUT.marketing}/PiB`, entity_type: "root" });
    expect(g.files.find((f) => f.id === scope!.folder_id)).toMatchObject({ name: "PiB", appProperties: { pibEntityType: "root", pibEntityId: "root:marketing:pib" } });
    expect(isAnchor(g.files.find((f) => f.id === scope!.folder_id)!)).toBe(false);
    expect((await b.resolve("project", "pm"))?.path).toBe(`${LAYOUT.marketing}/PiB/Spring Launch`);
  });

  it("an existing 02 Partners in Biz is used and only the missing Clients is created inside it, no duplicate", async () => {
    const g = fakeGoogle();
    g.files.push({ id: "human-pib", name: LAYOUT.pib, mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_ID] });
    await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(g.files.filter((f) => f.name === LAYOUT.pib)).toHaveLength(1);
    expect(anchorPaths(g.files)).toEqual([LAYOUT.clients]);
    expect(g.files.find((f) => f.name === "Clients")!.parents).toEqual(["human-pib"]);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib]);
  });

  it("a Google 503 while the layout folders are made: the retry resumes, nothing is duplicated and nothing lands at the root", async () => {
    const g = fakeGoogle();
    const b = broker(g);
    g.failNext({ method: "POST", skip: 1, status: 503 });
    const err = await b.ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" }).catch((e) => e);
    expect(err).toMatchObject({ status: 503, retryable: true });
    expect(folderPaths(g.files)).toEqual([LAYOUT.pib]);
    const r = await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(r).toMatchObject({ created: true, folder: { path: `${LAYOUT.clients}/Acme` } });
    expect(folderPaths(g.files)).toEqual([LAYOUT.pib, LAYOUT.clients, `${LAYOUT.clients}/Acme`]);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib]);
  });

  it("a layout folder whose creation answer was lost is adopted by name on the retry, not made twice", async () => {
    const g = fakeGoogle();
    g.failNext({ method: "POST", status: 502, applyFirst: true });
    const err = await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" }).catch((e) => e);
    expect(err).toMatchObject({ status: 502, retryable: true });
    expect(folderPaths(g.files)).toEqual([LAYOUT.pib]);
    const lost = g.files[0]!;
    await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(g.files.filter((f) => f.name === LAYOUT.pib)).toHaveLength(1);
    expect(g.files.find((f) => f.name === "Clients")!.parents).toEqual([lost.id]);
    expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib]);
  });

  describe("on a drive pre-seeded like the real one (human-made, untagged)", () => {
    it("resolve of a fixed root is the human-made folder and writes nothing", async () => {
      const g = fakeGoogle();
      const ids = seedPibDrive(g.files);
      const found = await broker(g).resolve("root", "root:products");
      expect(found).toMatchObject({ folder_id: ids[LAYOUT.products], path: LAYOUT.products });
      expect((await broker(g).resolve("root", "root:books"))?.folder_id).toBe(ids[LAYOUT.books]);
      expect((await broker(g).resolve("root", "root:company"))?.folder_id).toBe(ids[LAYOUT.internal]);
      expect((await broker(g).resolve("root", "root:marketing"))?.folder_id).toBe(ids[LAYOUT.marketing]);
      expect(g.calls.every((c) => c.startsWith("GET"))).toBe(true);
    });

    it("ensuring Hunt and Gun ADOPTS its existing folder (tag and description set, Assets untouched) and its project is built inside it", async () => {
      const g = fakeGoogle();
      const ids = seedPibDrive(g.files);
      const hgId = ids[HG]!;
      const snapshot = new Map(g.files.map((f) => [f.id, JSON.stringify(f)]));
      const humanCount = g.files.length;
      const b = broker(g);

      const company = await b.ensure({ entity_type: "crm_company", entity_id: "co-hg", name: "Hunt and Gun (Christo Barnard)" });
      expect(company.created).toBe(false);
      expect(company.folder.folder_id).toBe(hgId);
      expect(company.folder.path).toBe(HG);
      expect(company.folder.complete).toBe(true);
      expect(g.files).toHaveLength(humanCount);
      expect(g.files.find((f) => f.id === hgId)).toMatchObject({ description: HG, appProperties: { pibEntityType: "crm_company", pibEntityId: "co-hg", pibComplete: "1" } });
      expect((await broker(g).resolve("crm_company", "co-hg"))?.folder_id).toBe(hgId);

      const project = await b.ensure({ entity_type: "project", entity_id: "p-hg", name: "Hunt and Gun SEO", parent_entity_id: "co-hg", subfolders: [...DRIVE_SUBFOLDERS] });
      expect(project.created).toBe(true);
      expect(project.folder.path).toBe(`${HG}/Hunt and Gun SEO`);
      expect(g.files.find((f) => f.id === project.folder.folder_id)!.parents).toEqual([hgId]);
      expect(project.tree.map((t) => t.path)).toEqual(DRIVE_SUBFOLDERS.map((sub) => `${HG}/Hunt and Gun SEO/${sub}`));
      expect(project.tree.every((t) => t.created)).toBe(true);

      // Exactly the project and its six sub-folders are new; every human-made file is as it was, except the adopted folder's tag.
      expect(g.files).toHaveLength(humanCount + 1 + DRIVE_SUBFOLDERS.length);
      for (const [id, json] of snapshot) if (id !== hgId) expect(JSON.stringify(g.files.find((f) => f.id === id))).toBe(json);
      expect(g.files.find((f) => f.id === ids[`${HG}/Assets`])).toEqual(JSON.parse(snapshot.get(ids[`${HG}/Assets`]!)!));
      expect(g.files.filter((f) => f.parents.includes(hgId)).map((f) => f.name).sort()).toEqual(["Assets", "Contracts", "Hunt and Gun SEO"]);
      // Nothing at the drive root but the two human-made top-level folders; no anchor made, none duplicated.
      expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib, LAYOUT.press].sort());
      expect(g.files.filter(isAnchor)).toHaveLength(0);
      for (const name of ["Clients", "Products", "Own projects", "Internal", "Marketing & Sales", "Morgan Hale", LAYOUT.pib, LAYOUT.press]) expect(g.files.filter((f) => isFolder(f) && f.name === name)).toHaveLength(1);
      const paths = folderPaths(g.files);
      expect(new Set(paths).size).toBe(paths.length);

      // A repeat of both is a no-op.
      const count = g.files.length;
      expect((await broker(g).ensure({ entity_type: "crm_company", entity_id: "co-hg", name: "Hunt and Gun (Christo Barnard)" })).created).toBe(false);
      expect((await broker(g).ensure({ entity_type: "project", entity_id: "p-hg", name: "Hunt and Gun SEO", parent_entity_id: "co-hg", subfolders: [...DRIVE_SUBFOLDERS] })).created).toBe(false);
      expect(g.files).toHaveLength(count);
    });

    it("every kind of entity is built inside the existing folders: a new client under Clients, products, own projects, internal, marketing and books", async () => {
      const g = fakeGoogle();
      const ids = seedPibDrive(g.files);
      const humanCount = g.files.length;
      const b = broker(g);
      const made: Array<[DriveFacts, string, string]> = [
        [{ entityType: "project", entityId: "pn", name: "New Site", companyEntityId: "co-n", companyName: "Newco", contactName: "Sam" }, `${LAYOUT.clients}/Newco (Sam)/New Site`, LAYOUT.clients],
        [{ entityType: "project", entityId: "pp", name: "Widget", branch: "product" }, `${LAYOUT.products}/Widget`, LAYOUT.products],
        [{ entityType: "project", entityId: "po", name: "Solo" }, `${LAYOUT.ownProjects}/Solo`, LAYOUT.ownProjects],
        [{ entityType: "project", entityId: "pi", name: "Ops", branch: "company" }, `${LAYOUT.internal}/Ops`, LAYOUT.internal],
        [{ entityType: "project", entityId: "pk", name: "Launch", branch: "marketing" }, `${LAYOUT.marketing}/PiB/Launch`, `${LAYOUT.marketing}/PiB`],
        [{ entityType: "project", entityId: "pb", name: "Cool Book", branch: "book" }, `${LAYOUT.books}/Cool Book`, LAYOUT.books],
      ];
      for (const [facts, leafPath, parentPath] of made) {
        const leaf = await runPlan(b, facts);
        expect(leaf.folder.path).toBe(leafPath);
        expect(leaf.created).toBe(true);
        const parentId = parentPath === `${LAYOUT.marketing}/PiB` ? g.files.find((f) => f.name === "PiB")!.id : ids[parentPath]!;
        const leafFolder = g.files.find((f) => f.id === leaf.folder.folder_id)!;
        // The company folder sits between Clients and its project; every other leaf's parent is the existing folder.
        if (parentPath === LAYOUT.clients) expect(g.files.find((f) => f.id === leafFolder.parents[0])!.parents).toEqual([parentId]);
        else expect(leafFolder.parents).toEqual([parentId]);
      }
      expect(rootFolderNames(g.files)).toEqual([LAYOUT.pib, LAYOUT.press].sort());
      expect(g.files.filter(isAnchor)).toHaveLength(0);
      // Per project: leaf + six sub-folders; plus the new company folder and the PiB marketing scope folder.
      expect(g.files).toHaveLength(humanCount + made.length * (1 + DRIVE_SUBFOLDERS.length) + 2);
    });
  });
});

describe("parseServiceAccountKey", () => {
  it("rejects non-JSON, non-service-account and keyless input", () => {
    expect(() => parseServiceAccountKey("nope")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toThrow(/not a service account/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "service_account", client_email: "a@b" }))).toThrow(/no client_email or private_key/);
  });
});
