import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { planFolders, folderTarget, translateSubfolder, type DriveFacts, DRIVE_SUBFOLDERS, CLIENT_SUBFOLDERS, PRODUCT_SUBFOLDERS, LEGACY_SUBFOLDER_ALIASES } from "../src/drive/convention.js";
import { DriveNotBoundError } from "../src/drive/broker.js";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { clearServiceAccountTokenCache, parseServiceAccountKey } from "../src/drive/google-sa.js";
import { DRIVE_ID, KEY_JSON, LAYOUT, REAL_CLIENT_TREE, REAL_PRODUCT_TREE, anchorPaths, fakeGoogle, folderAt, isAnchor, isFolder, rootFolderNames, seedPibDrive, userFolderPaths, type FakeFile } from "./support/fake-google-drive.js";

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
/** Every folder below `base` for a list of (possibly nested) sub-folders, the intermediate ones included: "Assets/Images" is "Assets" and "Assets/Images". */
const treePaths = (base: string, subs: readonly string[]) => [...new Set(subs.flatMap((sub) => sub.split("/").map((_, i, parts) => `${base}/${parts.slice(0, i + 1).join("/")}`)))];
const CLIENT_PATHS = (base: string) => treePaths(base, REAL_CLIENT_TREE);
const PRODUCT_PATHS = (base: string) => treePaths(base, REAL_PRODUCT_TREE);

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("Drive convention (planFolders and the sub-folder lists)", () => {
  describe("sub-folder constants", () => {
    it("CLIENT_SUBFOLDERS and PRODUCT_SUBFOLDERS are the drive's own human-made trees, no numbered folders", () => {
      expect([...CLIENT_SUBFOLDERS]).toEqual([...REAL_CLIENT_TREE]);
      expect([...PRODUCT_SUBFOLDERS]).toEqual([...REAL_PRODUCT_TREE]);
      expect([...CLIENT_SUBFOLDERS, ...PRODUCT_SUBFOLDERS].some((name) => /^\d\d /.test(name))).toBe(false);
    });

    it("DRIVE_SUBFOLDERS (the tool enum and the validation list) is the client names then the product names", () => {
      expect([...DRIVE_SUBFOLDERS]).toEqual([...CLIENT_SUBFOLDERS, ...PRODUCT_SUBFOLDERS]);
      expect(new Set(DRIVE_SUBFOLDERS).size).toBe(DRIVE_SUBFOLDERS.length);
    });

    it("the legacy aliases map the five old numbered names to names in DRIVE_SUBFOLDERS, and 99 Archive has none", () => {
      expect({ ...LEGACY_SUBFOLDER_ALIASES }).toEqual({
        "01 Briefs": "Meetings & Notes",
        "02 Assets": "Assets/Social",
        "03 Deliverables": "Deliverables",
        "04 Reports": "Deliverables",
        "05 Evidence": "Meetings & Notes",
      });
      for (const target of Object.values(LEGACY_SUBFOLDER_ALIASES)) expect(DRIVE_SUBFOLDERS).toContain(target);
      expect(Object.keys(LEGACY_SUBFOLDER_ALIASES)).not.toContain("99 Archive");
    });

    it("translateSubfolder translates an alias and returns anything else as given (also a name like 'constructor')", () => {
      expect(translateSubfolder("02 Assets")).toBe("Assets/Social");
      expect(translateSubfolder("04 Reports")).toBe("Deliverables");
      expect(translateSubfolder("Deliverables")).toBe("Deliverables");
      expect(translateSubfolder("99 Archive")).toBe("99 Archive");
      expect(translateSubfolder("constructor")).toBe("constructor");
    });
  });

  describe("planFolders branches", () => {
    it("(1) client branch (default): ONE step, the company folder with the client sub-folders; no project step", () => {
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
        expect(plan.steps).toHaveLength(1);
        expect(plan.steps[0].entity_type).toBe("crm_company");
        expect(plan.steps[0].entity_id).toBe("co-a");
        expect(plan.steps[0].name).toBe("Acme Ltd (John Doe)");
        expect(plan.steps[0].parent_entity_id).toBeUndefined();
        expect(plan.steps[0].subfolders).toEqual([...CLIENT_SUBFOLDERS]);
        // The project's name appears nowhere: its folder IS the company's
        expect(JSON.stringify(plan.steps)).not.toContain("Website");
        expect(plan.steps.some((step) => step.entity_type === "project")).toBe(false);
      }
    });

    it("(1b) two projects of one client plan the very same step (they share the company's folder)", () => {
      const client = { companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" };
      const a = planFolders({ entityType: "project", entityId: "p-seo", name: "Acme SEO", ...client }, []);
      const b = planFolders({ entityType: "project", entityId: "p-web", name: "Acme Website", ...client }, []);
      expect(a.kind).toBe("ensure");
      expect(b).toEqual(a);
    });

    it("(1c) a company asked for on its own plans the same step as its project does", () => {
      const own = planFolders({ entityType: "crm_company", entityId: "co-a", name: "Acme Ltd", contactName: "John Doe" }, []);
      const viaProject = planFolders({ entityType: "project", entityId: "p1", name: "Website", companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" }, []);
      expect(own).toEqual(viaProject);
    });

    it("(1d) folderTarget: a client project's folder is its company's; every other project (and a company) is its own", () => {
      const client = { companyEntityId: "co-a", companyName: "Acme Ltd" };
      expect(folderTarget({ entityType: "project", entityId: "p1", name: "Site", ...client })).toEqual({ entityType: "crm_company", entityId: "co-a" });
      expect(folderTarget({ entityType: "project", entityId: "p1", name: "Site", branch: "client", ...client })).toEqual({ entityType: "crm_company", entityId: "co-a" });
      expect(folderTarget({ entityType: "crm_company", entityId: "co-a", name: "Acme Ltd" })).toEqual({ entityType: "crm_company", entityId: "co-a" });
      for (const branch of ["product", "book", "company", "marketing"] as const) {
        expect(folderTarget({ entityType: "project", entityId: "p1", name: "Site", branch, ...client })).toEqual({ entityType: "project", entityId: "p1" });
      }
      // No company link, or a link without a company to name the folder by: the project is its own folder (Own projects)
      expect(folderTarget({ entityType: "project", entityId: "p1", name: "Solo" })).toEqual({ entityType: "project", entityId: "p1" });
      expect(folderTarget({ entityType: "project", entityId: "p1", name: "Solo", companyEntityId: "co-gone" })).toEqual({ entityType: "project", entityId: "p1" });
    });

    it("(2) product branch: root:products -> project with parent_entity_type=root and the product sub-folders", () => {
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
        expect(plan.steps[1].subfolders).toEqual([...PRODUCT_SUBFOLDERS]);
      }
    });

    it("(3) book branch: root:books -> project with parent_entity_type=root, no sub-folders", () => {
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
        expect(plan.steps[1].subfolders).toBeUndefined();
      }
    });

    it("(4) company branch: root:company -> project area, no sub-folders", () => {
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
        expect(plan.steps[1].subfolders).toBeUndefined();
      }
    });

    it("(5) marketing branch: root:marketing -> scope -> campaign with parent_entity_type=root, no sub-folders", () => {
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
        expect(plan.steps[2].subfolders).toBeUndefined();
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
    it("(7) client project with no company link (entityType=project, no companyEntityId): its own project step with the client sub-folders", () => {
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
        expect(plan.steps[0].subfolders).toEqual([...CLIENT_SUBFOLDERS]);
      }
    });

    it("(7b) a company link without a company to name the folder by falls back to the project's own folder", () => {
      const plan = planFolders({ entityType: "project", entityId: "p1", name: "Solo", companyEntityId: "co-gone" }, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps.map((step) => [step.entity_type, step.entity_id])).toEqual([["project", "p1"]]);
        expect(plan.steps[0].subfolders).toEqual([...CLIENT_SUBFOLDERS]);
      }
    });

    it("(7c) a company-linked project of a non-client kind plans its branch, not the client's folder", () => {
      const plan = planFolders({ entityType: "project", entityId: "p1", name: "Widget", branch: "product", companyEntityId: "co-a", companyName: "Acme Ltd" }, []);
      expect(plan.kind).toBe("ensure");
      if (plan.kind === "ensure") {
        expect(plan.steps.map((step) => step.entity_type)).toEqual(["root", "project"]);
        expect(plan.steps.some((step) => step.entity_type === "crm_company")).toBe(false);
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
      const client: DriveFacts = { entityType: "project", entityId: "p1", name: "Website", companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" };
      const product: DriveFacts = { entityType: "project", entityId: "p1", name: "Widget", branch: "product" };
      const withRun = planFolders(client, [], "run-7");
      expect(withRun.kind).toBe("ensure");
      if (withRun.kind === "ensure") expect(withRun.steps.map((step) => step.created_by_run)).toEqual(["run-7"]);
      const twoSteps = planFolders(product, [], "run-7");
      expect(twoSteps.kind).toBe("ensure");
      if (twoSteps.kind === "ensure") expect(twoSteps.steps.map((step) => step.created_by_run)).toEqual(["run-7", "run-7"]);
      for (const facts of [client, product]) {
        const without = planFolders(facts, []);
        if (without.kind === "ensure") expect(without.steps.every((step) => step.created_by_run === undefined)).toBe(true);
      }
    });

    it("(12c) collision is checked on the folder that is made: a client project against the other companies' folders, not against sibling projects", () => {
      const facts: DriveFacts = { entityType: "project", entityId: "p1", name: "Site", companyEntityId: "co-a", companyName: "Acme Ltd", contactName: "John Doe" };
      const twin = planFolders(facts, [{ entityType: "crm_company", entityId: "co-b", name: "acme  ltd (john doe)" }]);
      expect(twin.kind).toBe("needs_human_look");
      if (twin.kind === "needs_human_look") expect(twin.conflictsWith).toEqual([{ entityType: "crm_company", entityId: "co-b", name: "acme  ltd (john doe)" }]);
      // A sibling project with the very same name is no conflict: both projects use the company's folder
      expect(planFolders(facts, [{ entityType: "project", entityId: "p2", name: "Site" }]).kind).toBe("ensure");
      // The company itself is never its own conflict
      expect(planFolders(facts, [{ entityType: "crm_company", entityId: "co-a", name: "Acme Ltd (John Doe)" }]).kind).toBe("ensure");
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
      // The client's project has no folder of its own: it is the company's
      expect(folderOf(googleA.files, "project", "p1")).toBeUndefined();
      expect(folderOf(googleB.files, "project", "p2")).toMatchObject({ name: "ProjectB", parents: [googleB.files.find((f) => f.name === "Own projects")!.id] });
      expect(rootFolderNames(googleA.files, "drive-A")).toEqual([LAYOUT.pib]);
      expect(rootFolderNames(googleB.files, "drive-B")).toEqual([LAYOUT.pib]);
      expect(googleA.calls.some((c) => c.includes("drive-B"))).toBe(false);
      expect(googleB.calls.some((c) => c.includes("drive-A"))).toBe(false);
    });

    it("(21) project with no project_drive_kind: produces the client chain, ONE company folder with the client sub-folders and no project folder", async () => {
      const st = seed();
      linked(st, "co-c", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ClientProject" } as never] });

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      const company = `${LAYOUT.clients}/Acme Ltd (Primary Contact)`;
      // The project's folder is the company's: same path, same folder id
      expect(r.data?.path).toBe(company);
      const companyFolder = folderOf(google.files, "crm_company", "co-c");
      const clients = google.files.find((f) => f.name === "Clients")!;
      expect(companyFolder).toMatchObject({ name: "Acme Ltd (Primary Contact)", parents: [clients.id], description: company });
      expect(r.data?.folder_id).toBe(companyFolder!.id);
      expect(folderOf(google.files, "project", "p1")).toBeUndefined();
      expect(google.files.some((f) => f.name === "ClientProject")).toBe(false);
      // The tree has one entry per client sub-folder (the leaf of each path), all newly made
      expect(r.data?.tree).toHaveLength(CLIENT_SUBFOLDERS.length);
      expect(r.data?.tree.map((t: any) => t.path)).toEqual(CLIENT_SUBFOLDERS.map((sub) => `${company}/${sub}`));
      expect(r.data?.tree.every((t: any) => t.created === true)).toBe(true);
      expect(anchorPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.clients]);
      expect(userFolderPaths(google.files)).toEqual([company, ...CLIENT_PATHS(company)].sort());
      expect(rootFolderNames(google.files)).toEqual([LAYOUT.pib]);
    });

    it("(21b) a company ensured on its own lands in Clients as 'Company (Contact)' with the client sub-folders; its project's ensure is then the same folder", async () => {
      const st = seed();
      linked(st, "co-x", "Acme Ltd");
      const { harness, google } = await setup(NATIVE, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });

      const c = await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: "co-x" });

      const company = `${LAYOUT.clients}/Acme Ltd (Primary Contact)`;
      expect(c.data?.status).toBe("created");
      expect(c.data?.path).toBe(company);
      expect(userFolderPaths(google.files)).toEqual([company, ...CLIENT_PATHS(company)].sort());
      const count = google.files.length;
      const p = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(p.data?.status).toBe("exists");
      expect(p.data?.path).toBe(company);
      expect(p.data?.folder_id).toBe(c.data?.folder_id);
      expect(google.files).toHaveLength(count);
      expect(google.files.filter((f) => f.name.startsWith("Acme Ltd"))).toHaveLength(1);
    });

    it("(22) project with product kind: produces the Products chain with the product sub-folders", async () => {
      const { harness, google } = await setup();
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProductProject" } as never] });
      expect((await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind: "product" })).data?.status).toBe("set");

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      expect(r.data?.path).toBe(`${LAYOUT.products}/ProductProject`);
      expect(r.data?.tree.map((t: any) => t.path)).toEqual(PRODUCT_SUBFOLDERS.map((sub) => `${LAYOUT.products}/ProductProject/${sub}`));
      // Products is the existing folder at its fixed path (an anchor), not a registered root folder of its own.
      expect(folderOf(google.files, "root", "root:products")).toBeUndefined();
      const products = google.files.find((f) => f.name === "Products")!;
      expect(isAnchor(products)).toBe(true);
      expect(products.parents).toEqual([google.files.find((f) => f.name === LAYOUT.pib)!.id]);
      expect(folderOf(google.files, "project", "p1")!.parents).toEqual([products.id]);
      expect(anchorPaths(google.files)).toEqual([LAYOUT.pib, LAYOUT.products]);
      expect(userFolderPaths(google.files)).toEqual([`${LAYOUT.products}/ProductProject`, ...PRODUCT_PATHS(`${LAYOUT.products}/ProductProject`)].sort());
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

    it.each(cases)("(25) kind %s (scope %s) builds %s inside the existing layout folders, with only its top-level folder at the Shared Drive root; only a product gets sub-folders", async (kind, scopeRef, leafPath, top, anchors) => {
      const { harness, google } = await setup();
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Widget" } as never] });
      expect((await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind, ...(scopeRef ? { scopeRef } : {}) })).data?.status).toBe("set");

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      expect(r.data?.status).toBe("created");
      expect(r.data?.path).toBe(leafPath);
      const paths = userFolderPaths(google.files);
      expect(paths).toContain(leafPath);
      const below = paths.filter((path) => path.startsWith(`${leafPath}/`));
      if (kind === "product") {
        expect(below).toEqual(PRODUCT_PATHS(leafPath).sort());
        expect(r.data?.tree).toHaveLength(PRODUCT_SUBFOLDERS.length);
      } else {
        // A book, company or marketing folder has no standard sub-folders: the leaf folder is all there is, and its tree is empty
        expect(below).toEqual([]);
        expect(r.data?.tree).toEqual([]);
      }
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
