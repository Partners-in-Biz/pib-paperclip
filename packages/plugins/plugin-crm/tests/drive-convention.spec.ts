import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { planFolders, type DriveFacts, DRIVE_SUBFOLDERS } from "../src/drive/convention.js";
import { DriveNotBoundError } from "../src/drive/broker.js";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { clearServiceAccountTokenCache, parseServiceAccountKey } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, LAYOUT, anchorPaths, fakeGoogle, isAnchor, isFolder, rootFolderNames, userFolderPaths, type FakeFile } from "./support/fake-google-drive.js";

const NATIVE = { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID } };

function linked(baseSeed: Record<string, any>, coId: string, name: string) {
  const contactId = `contact-${coId}`;
  baseSeed.companies!.push(company(coId, name));
  baseSeed.contacts!.push(contact(contactId, "Primary Contact"));
  baseSeed.contact_companies!.push({ id: `cc-${coId}`, company_id: CO, contact_id: contactId, account_id: coId, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  baseSeed.client_projects!.push({ id: `cp-${coId}`, company_id: CO, project_id: "p1", client_kind: "company", client_ref: coId, created_at: "2026-01-01T00:00:00Z" });
}

/** The tool layer on the native path: the service account key in the CRM settings, Google (faked, in memory) as the only server. */
async function setup(config: Record<string, any> = NATIVE, store?: Record<string, any>, google = fakeGoogle()) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const fetchSpy = vi.fn(google.fetchFn);
  vi.stubGlobal("fetch", fetchSpy);
  return { harness, google, fetchSpy };
}

/** The folder Drive holds for a Paperclip entity (its registry is the appProperties on the folder). */
const folderOf = (files: FakeFile[], type: string, id: string) => files.find((f) => isFolder(f) && f.appProperties?.pibEntityType === type && f.appProperties?.pibEntityId === id);
const SUB_PATHS = (base: string) => DRIVE_SUBFOLDERS.map((sub) => `${base}/${sub}`);

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("Drive convention (planFolders and DRIVE_SUBFOLDERS)", () => {
  describe("DRIVE_SUBFOLDERS constant", () => {
    it("exports DRIVE_SUBFOLDERS with standard folder names", () => {
      expect(DRIVE_SUBFOLDERS).toEqual(["01 Briefs", "02 Assets", "03 Deliverables", "04 Reports", "05 Evidence", "99 Archive"]);
    });
  });

  describe("planFolders branches", () => {
    it("(1) client branch (default): company -> project with parent_entity_id and subfolders", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "Website",
        companyEntityId: "co-a",
        companyName: "Acme Ltd",
        contactName: "John Doe",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0].entity_type).toBe("crm_company");
        expect(plan.steps[0].entity_id).toBe("co-a");
        expect(plan.steps[0].name).toBe("Acme Ltd (John Doe)");
        expect(plan.steps[0].parent_entity_id).toBeUndefined();
        expect(plan.steps[0].subfolders).toBeUndefined();

        expect(plan.steps[1].entity_type).toBe("project");
        expect(plan.steps[1].entity_id).toBe("p1");
        expect(plan.steps[1].name).toBe("Website");
        expect(plan.steps[1].parent_entity_id).toBe("co-a");
        expect(plan.steps[1].subfolders).toEqual(Array.from(DRIVE_SUBFOLDERS));
      }
    });

    it("(2) product branch: root:products -> project with parent_entity_type=root", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "Widget",
        branch: "product",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0].entity_type).toBe("root");
        expect(plan.steps[0].entity_id).toBe("root:products");
        expect(plan.steps[0].name).toBe("Products");
        expect(plan.steps[0].parent_entity_id).toBeUndefined();
        expect(plan.steps[0].parent_entity_type).toBeUndefined();

        expect(plan.steps[1].entity_type).toBe("project");
        expect(plan.steps[1].entity_id).toBe("p1");
        expect(plan.steps[1].name).toBe("Widget");
        expect(plan.steps[1].parent_entity_id).toBe("root:products");
        expect(plan.steps[1].parent_entity_type).toBe("root");
        expect(plan.steps[1].subfolders).toEqual(DRIVE_SUBFOLDERS);
      }
    });

    it("(3) book branch: root:books -> project with parent_entity_type=root", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "Guide",
        branch: "book",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0].entity_type).toBe("root");
        expect(plan.steps[0].entity_id).toBe("root:books");
        expect(plan.steps[0].name).toBe("Books");

        expect(plan.steps[1].entity_type).toBe("project");
        expect(plan.steps[1].parent_entity_id).toBe("root:books");
        expect(plan.steps[1].parent_entity_type).toBe("root");
      }
    });

    it("(4) company branch: root:company -> project area", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "Marketing Plan",
        branch: "company",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(2);
        expect(plan.steps[0].entity_type).toBe("root");
        expect(plan.steps[0].entity_id).toBe("root:company");
        expect(plan.steps[0].name).toBe("Company");

        expect(plan.steps[1].entity_type).toBe("project");
        expect(plan.steps[1].parent_entity_id).toBe("root:company");
        expect(plan.steps[1].parent_entity_type).toBe("root");
      }
    });

    it("(5) marketing branch: root:marketing -> scope -> campaign with parent_entity_type=root", () => {
      const facts: DriveFacts = {
        entityType: "campaign",
        entityId: "camp1",
        name: "Q4 Push",
        branch: "marketing",
        scopeRef: "PiB",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(3);
        expect(plan.steps[0].entity_type).toBe("root");
        expect(plan.steps[0].entity_id).toBe("root:marketing");
        expect(plan.steps[0].name).toBe("Marketing");

        expect(plan.steps[1].entity_type).toBe("root");
        expect(plan.steps[1].entity_id).toMatch(/^root:marketing:/);
        expect(plan.steps[1].name).toBe("PiB");
        expect(plan.steps[1].parent_entity_id).toBe("root:marketing");
        expect(plan.steps[1].parent_entity_type).toBe("root");

        expect(plan.steps[2].entity_type).toBe("campaign");
        expect(plan.steps[2].entity_id).toBe("camp1");
        expect(plan.steps[2].name).toBe("Q4 Push");
        expect(plan.steps[2].parent_entity_id).toMatch(/^root:marketing:/);
        expect(plan.steps[2].parent_entity_type).toBe("root");
        expect(plan.steps[2].subfolders).toEqual(DRIVE_SUBFOLDERS);
      }
    });

    it("(6) marketing branch with default scope when scopeRef absent", () => {
      const facts: DriveFacts = {
        entityType: "campaign",
        entityId: "camp1",
        name: "Campaign",
        branch: "marketing",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps[1].name).toBe("PiB");
      }
    });
  });

  describe("planFolders validation", () => {
    it("(7) client project with no company link (entityType=project, no companyEntityId)", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p-unlinked",
        name: "Solo",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0].entity_type).toBe("project");
        expect(plan.steps[0].parent_entity_id).toBeUndefined();
      }
    });

    it("(8) invalid_name for UUID in project name", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("invalid_name");
      if (plan.kind === "invalid_name") {
        expect(plan.problem).toBe("uuid");
      }
    });

    it("(9) invalid_name for issue key PAR-123", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "PAR-123",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("invalid_name");
      if (plan.kind === "invalid_name") {
        expect(plan.problem).toBe("issue_key");
      }
    });

    it("(10) invalid_name for long CamelCase drive_id", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "ProjectManagementDashboardV2",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("invalid_name");
      if (plan.kind === "invalid_name") {
        expect(plan.problem).toBe("drive_id");
      }
    });

    it("(11) invalid_name for invalid marketing scope (UUID)", () => {
      const facts: DriveFacts = {
        entityType: "campaign",
        entityId: "camp1",
        name: "Campaign",
        branch: "marketing",
        scopeRef: "3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("invalid_name");
      if (plan.kind === "invalid_name") {
        expect(plan.problem).toBe("uuid");
      }
    });

    it("(12) no steps executed for invalid_name", () => {
      const facts: DriveFacts = {
        entityType: "project",
        entityId: "p1",
        name: "PAR-123",
      };
      const plan = planFolders(facts, []);
      expect(plan.kind).toBe("invalid_name");
      if (plan.kind === "invalid_name") {
        // invalid_name plans don't have a steps property
        expect((plan as any).steps).toBeUndefined();
      }
    });

    it("(12b) the run id is carried on every step of the plan (and absent when there is no run)", () => {
      const facts: DriveFacts = { entityType: "project", entityId: "p1", name: "Website", companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" };
      const withRun = planFolders(facts, [], "run-7");
      expect(withRun.kind).toBe("ensure");
      if (withRun.kind === "ensure") expect(withRun.steps.map((step) => step.created_by_run)).toEqual(["run-7", "run-7"]);
      const without = planFolders(facts, []);
      if (without.kind === "ensure") expect(without.steps.every((step) => step.created_by_run === undefined)).toBe(true);
    });
  });

  describe("createGoogleDriveBroker with sharedDriveId binding", () => {
    const key = () => parseServiceAccountKey(KEY_JSON);

    it("(13) throws DriveNotBoundError if sharedDriveId is empty string", () => {
      const g = fakeGoogle();
      expect(() => createGoogleDriveBroker(g.fetchFn, key(), "")).toThrow(DriveNotBoundError);
      expect(g.calls.length).toBe(0);
    });

    it("(14) throws DriveNotBoundError if sharedDriveId is whitespace", () => {
      const g = fakeGoogle();
      expect(() => createGoogleDriveBroker(g.fetchFn, key(), "   ")).toThrow(DriveNotBoundError);
      expect(g.calls.length).toBe(0);
    });

    it("(15) DriveNotBoundError has code='drive_not_bound'", () => {
      try {
        createGoogleDriveBroker(fakeGoogle().fetchFn, key(), "");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DriveNotBoundError);
        expect((e as any).code).toBe("drive_not_bound");
      }
    });

    it("(16) Google is never called (not even for a token) if the sharedDriveId check fails", () => {
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
      try {
        createGoogleDriveBroker(fetchFn, key(), "");
      } catch {
        // expected
      }
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("(17) two brokers with different sharedDriveIds scope their lookups to their own drive", async () => {
      const g1 = fakeGoogle({ driveId: "drive-A" });
      const g2 = fakeGoogle({ driveId: "drive-B" });
      const broker1 = createGoogleDriveBroker(g1.fetchFn, key(), "drive-A");
      const broker2 = createGoogleDriveBroker(g2.fetchFn, key(), "drive-B");

      await broker1.resolve("project", "p1");
      await broker2.resolve("project", "p2");

      expect(g1.calls.length).toBeGreaterThan(0);
      expect(g1.calls.every((c) => c.includes("corpora=drive") && c.includes("driveId=drive-A"))).toBe(true);
      expect(g2.calls.length).toBeGreaterThan(0);
      expect(g2.calls.every((c) => c.includes("corpora=drive") && c.includes("driveId=drive-B"))).toBe(true);
    });

    it("(18) two brokers with different sharedDriveIds create their folders in their own drive", async () => {
      const g1 = fakeGoogle({ driveId: "drive-A" });
      const g2 = fakeGoogle({ driveId: "drive-B" });
      const broker1 = createGoogleDriveBroker(g1.fetchFn, key(), "drive-A");
      const broker2 = createGoogleDriveBroker(g2.fetchFn, key(), "drive-B");

      await broker1.ensure({ entity_type: "project", entity_id: "p1", name: "P1" });
      await broker2.ensure({ entity_type: "project", entity_id: "p2", name: "P2" });

      // Each drive gets its own 02 Partners in Biz > Own projects > project chain, and nothing at its root but 02 Partners in Biz.
      for (const [g, driveId, name] of [[g1, "drive-A", "P1"], [g2, "drive-B", "P2"]] as const) {
        expect(g.files).toHaveLength(3);
        expect(g.files.find((f) => f.name === name)).toMatchObject({ parents: [g.files.find((f) => f.name === "Own projects")!.id], description: `${LAYOUT.ownProjects}/${name}` });
        expect(g.files.find((f) => f.name === LAYOUT.pib)).toMatchObject({ parents: [driveId] });
        expect(rootFolderNames(g.files, driveId)).toEqual([LAYOUT.pib]);
      }
      expect(userFolderPaths(g1.files, "drive-A")).toEqual([`${LAYOUT.ownProjects}/P1`]);
      expect(userFolderPaths(g2.files, "drive-B")).toEqual([`${LAYOUT.ownProjects}/P2`]);
    });
  });

  describe("tool-level: driveFolderEnsure with drive binding", () => {
    it("(19) company with NO sharedDriveId: ensure returns drive_not_bound, Google not called", async () => {
      const { harness, google, fetchSpy } = await setup({ driveServiceAccountJson: KEY_JSON }, seed());
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Test" } as never] });
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r.data?.status).toBe("drive_not_bound");
      expect(google.calls.length).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      const resolved = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
      expect(resolved.data?.status).toBe("drive_not_bound");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("(20) two companies with different drives: each builds its folders in its own Shared Drive", async () => {
      const st = seed();
      linked(st, "co-a", "Company A");
      const googleA = fakeGoogle({ driveId: "drive-A" });
      const googleB = fakeGoogle({ driveId: "drive-B" });
      const a = await setup({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "drive-A" } }, st, googleA);
      a.harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProjectA" } as never] });
      await toolRaw(a.harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      const b = await setup({ driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: "drive-B" } }, seed(), googleB);
      b.harness.seed({ projects: [{ id: "p2", companyId: CO, name: "ProjectB" } as never] });
      await toolRaw(b.harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });

      const clientsA = googleA.files.find((f) => f.name === "Clients")!;
      expect(folderOf(googleA.files, "crm_company", "co-a")).toMatchObject({ name: "Company A (Primary Contact)", parents: [clientsA.id] });
      expect(clientsA.parents).toEqual([googleA.files.find((f) => f.name === LAYOUT.pib)!.id]);
      expect(folderOf(googleA.files, "project", "p1")?.name).toBe("ProjectA");
      expect(folderOf(googleB.files, "project", "p2")).toMatchObject({ name: "ProjectB", parents: [googleB.files.find((f) => f.name === "Own projects")!.id] });
      expect(rootFolderNames(googleA.files, "drive-A")).toEqual([LAYOUT.pib]);
      expect(rootFolderNames(googleB.files, "drive-B")).toEqual([LAYOUT.pib]);
      expect(googleA.calls.some((c) => c.includes("drive-B"))).toBe(false);
      expect(googleB.calls.some((c) => c.includes("drive-A"))).toBe(false);
    });

    it("(21) project with no project_drive_kind: produces the client chain, company folder then project folder", async () => {
      const st = seed();
      linked(st, "co-c", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ClientProject" } as never] });

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      const company = `${LAYOUT.clients}/Acme Ltd (Primary Contact)`;
      expect(r.data?.path).toBe(`${company}/ClientProject`);
      // Company first (in Clients, never at the root), then the project inside it; the registry is each folder's appProperties
      const companyFolder = folderOf(google.files, "crm_company", "co-c");
      const projectFolder = folderOf(google.files, "project", "p1");
      const clients = google.files.find((f) => f.name === "Clients")!;
      expect(companyFolder).toMatchObject({ name: "Acme Ltd (Primary Contact)", parents: [clients.id] });
      expect(projectFolder).toMatchObject({ name: "ClientProject", parents: [companyFolder!.id] });
      expect(google.files.indexOf(companyFolder!)).toBeLessThan(google.files.indexOf(projectFolder!));
      expect(anchorPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.clients]);
      expect(userFolderPaths(google.files)).toEqual([company, `${company}/ClientProject`, ...SUB_PATHS(`${company}/ClientProject`)].sort());
      expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
    });

    it("(21b) a company ensured on its own lands in Clients as 'Company (Contact)'; its project is built inside it later", async () => {
      const st = seed();
      linked(st, "co-x", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });

      const c = await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: "co-x" });

      expect(c.data?.status).toBe("created");
      expect(c.data?.path).toBe(`${LAYOUT.clients}/Acme Ltd (Primary Contact)`);
      expect(userFolderPaths(google.files)).toEqual([`${LAYOUT.clients}/Acme Ltd (Primary Contact)`]);
      const p = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(p.data?.path).toBe(`${LAYOUT.clients}/Acme Ltd (Primary Contact)/Site`);
      expect(folderOf(google.files, "project", "p1")!.parents).toEqual([c.data?.folder_id]);
      expect(google.files.filter((f) => f.name.startsWith("Acme Ltd"))).toHaveLength(1);
    });

    it("(22) project with product kind: produces the Products chain with the numbered sub-folders", async () => {
      const { harness, google } = await setup();
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProductProject" } as never] });
      expect((await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind: "product" })).data?.status).toBe("set");

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      expect(r.data?.path).toBe(`${LAYOUT.products}/ProductProject`);
      // Products is the existing folder at its fixed path (an anchor), not a registered root folder of its own.
      expect(folderOf(google.files, "root", "root:products")).toBeUndefined();
      const products = google.files.find((f) => f.name === "Products")!;
      expect(isAnchor(products)).toBe(true);
      expect(products.parents).toEqual([google.files.find((f) => f.name === LAYOUT.pib)!.id]);
      expect(folderOf(google.files, "project", "p1")!.parents).toEqual([products.id]);
      expect(anchorPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.products]);
      expect(userFolderPaths(google.files)).toEqual([`${LAYOUT.products}/ProductProject`, ...SUB_PATHS(`${LAYOUT.products}/ProductProject`)].sort());
      expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
      expect(google.files.some((f) => f.appProperties?.pibEntityType === "crm_company")).toBe(false);
    });

    it("(23) ensure called twice: second returns exists, nothing new in Drive", async () => {
      const st = seed();
      linked(st, "co-d", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Twice" } as never] });

      const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r1.data?.status).toBe("created");
      const filesAfterFirst = google.files.length;
      const writesAfterFirst = google.calls.filter((c) => !c.startsWith("GET")).length;

      const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r2.data?.status).toBe("exists");
      expect(google.files.length).toBe(filesAfterFirst);
      expect(google.calls.filter((c) => !c.startsWith("GET")).length).toBe(writesAfterFirst);
    });

    it("(24) invalid project name: returns invalid_name, nothing is created in Drive", async () => {
      const { harness, google } = await setup();
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "PAR-123" } as never] });

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r.data?.status).toBe("invalid_name");
      expect(google.files).toHaveLength(0);
      expect(google.calls.every((c) => c.startsWith("GET"))).toBe(true);
    });
  });

  describe("tool-level: branch routing by the project's Drive kind", () => {
    // kind, scope, the leaf path, the top-level folder (the only thing made at the Shared Drive root) and the layout folders made on the way
    const cases: Array<[string, string | undefined, string, string, string[]]> = [
      ["product", undefined, `${LAYOUT.products}/Widget`, LAYOUT.pib, [LAYOUT.pib, LAYOUT.products]],
      ["book", undefined, `${LAYOUT.books}/Widget`, LAYOUT.press, [LAYOUT.press, LAYOUT.books]],
      ["company", undefined, `${LAYOUT.internal}/Widget`, LAYOUT.pib, [LAYOUT.pib, LAYOUT.internal]],
      ["marketing", undefined, `${LAYOUT.marketing}/PiB/Widget`, LAYOUT.pib, [LAYOUT.pib, LAYOUT.marketing]],
      ["marketing", "Acme Launch", `${LAYOUT.marketing}/Acme Launch/Widget`, LAYOUT.pib, [LAYOUT.pib, LAYOUT.marketing]],
    ];

    it.each(cases)("(25) kind %s (scope %s) builds %s inside the existing layout folders, with the numbered sub-folders and only its top-level folder at the Shared Drive root", async (kind, scopeRef, leafPath, top, anchors) => {
      const { harness, google } = await setup();
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Widget" } as never] });
      expect((await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind, ...(scopeRef ? { scopeRef } : {}) })).data?.status).toBe("set");

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      expect(r.data?.path).toBe(leafPath);
      const paths = userFolderPaths(google.files);
      expect(paths).toEqual(expect.arrayContaining([leafPath, ...SUB_PATHS(leafPath)]));
      expect(anchorPaths(google.files)).toEqual([...anchors].sort());
      // Every folder is a plain chain from the top-level folder: the first segment of each path is the one folder made at the root
      expect(paths.every((path) => path.startsWith(`${top}/`))).toBe(true);
      expect(rootFolderNames(google.files)).toEqual([top]);
      // Never under a company folder, whatever the project is linked to
      expect(google.files.some((f) => f.appProperties?.pibEntityType === "crm_company")).toBe(false);
    });

    it("(26) a company-linked project of a non-client kind goes to its branch, not into the client's folder", async () => {
      const st = seed();
      linked(st, "co-p", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Widget" } as never] });
      await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind: "product" });

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.path).toBe(`${LAYOUT.products}/Widget`);
      expect(google.files.some((f) => f.name.startsWith("Acme Ltd"))).toBe(false);
      expect(google.files.some((f) => f.name === "Clients")).toBe(false);
    });

    it("(27) a repeat ensure on a non-client branch changes nothing in Drive", async () => {
      const { harness, google } = await setup();
      for (const kind of ["product", "book", "company", "marketing"]) {
        const id = `p-${kind}`;
        harness.seed({ projects: [{ id, companyId: CO, name: `Widget ${kind}` } as never] });
        await toolRaw(harness, "drive_project_kind_set", { projectId: id, kind });
        const first = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: id });
        expect(first.data?.status).toBe("created");
        const before = google.files.map((f) => f.id);
        const again = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: id });
        expect(again.error).toBeUndefined();
        expect(["created", "exists"]).toContain(again.data?.status);
        expect(again.data?.folder_id).toBe(first.data?.folder_id);
        expect(google.files.map((f) => f.id)).toEqual(before);
      }
    });
  });
});
