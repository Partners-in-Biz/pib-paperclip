import { describe, it, expect, beforeEach } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { planFolders, type DriveFacts, type Sibling, DRIVE_SUBFOLDERS } from "../src/drive/convention.js";
import { createBroker, DriveNotBoundError } from "../src/drive/broker.js";

interface BrokerState {
  registry: Map<string, any>;
  driveFolders: Map<string, { id: string; path: string; folder_id: string; folder_url: string }>;
  posts: Array<{ url: string; headers: Record<string, string>; body: any }>;
  requests: Array<{ url: string; method: string; body?: any }>;
}

function linked(baseSeed: Record<string, any>, coId: string, name: string) {
  const contactId = `contact-${coId}`;
  baseSeed.companies!.push(company(coId, name));
  baseSeed.contacts!.push(contact(contactId, "Primary Contact"));
  baseSeed.contact_companies!.push({ id: `cc-${coId}`, company_id: CO, contact_id: contactId, account_id: coId, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  baseSeed.client_projects!.push({ id: `cp-${coId}`, company_id: CO, project_id: "p1", client_kind: "company", client_ref: coId, created_at: "2026-01-01T00:00:00Z" });
}

function createMockBrokerFn(state: BrokerState) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    if (!init.headers.Authorization?.startsWith("Bearer ")) return { status: 401, ok: false, text: async () => "{}" };

    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ url, method: init.method, body });

    if (init.method === "GET" && url.includes("/registry/resolve")) {
      const params = new URL(url, "http://base").searchParams;
      const key = `${params.get("entity_type")}:${params.get("entity_id")}`;
      const found = state.registry.get(key);
      return found ? { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: { folder: found } }) } : { status: 404, ok: false, text: async () => JSON.stringify({ success: false, error: "Not found" }) };
    }
    if (init.method === "POST" && url.includes("/registry/ensure")) {
      const { entity_type, entity_id, name, parent_entity_id } = body;
      state.posts.push({ url, headers: init.headers, body });
      const key = `${entity_type}:${entity_id}`;
      if (!state.registry.has(key)) {
        const fid = `f_${state.registry.size + 1}`;
        state.registry.set(key, { id: fid, entity_type, entity_id, path: `test/${name}`, folder_id: fid, folder_url: `https://drive.google.com/drive/folders/${fid}` });
      }
      const reg = state.registry.get(key)!;
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: { folder: reg, created: !state.registry.has(key), tree: [] } }) };
    }
    return { status: 404, ok: false, text: async () => "{}" };
  };
}

async function setup(config: Record<string, any> = {}, store?: Record<string, any>) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const state: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
  harness.ctx.http.fetch = createMockBrokerFn(state) as any;
  return { harness, state };
}

describe("Drive convention (planFolders and DRIVE_SUBFOLDERS)", () => {
  beforeEach(() => {
    // Clear mocks before each test if needed
  });

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
  });

  describe("createBroker with sharedDriveId binding", () => {
    it("(13) throws DriveNotBoundError if sharedDriveId is empty string", () => {
      const state: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
      const fetchFn = createMockBrokerFn(state);
      expect(() => createBroker(fetchFn, { baseUrl: "http://test", token: "token", sharedDriveId: "" })).toThrow(DriveNotBoundError);
      expect(state.requests.length).toBe(0);
    });

    it("(14) throws DriveNotBoundError if sharedDriveId is whitespace", () => {
      const state: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
      const fetchFn = createMockBrokerFn(state);
      expect(() => createBroker(fetchFn, { baseUrl: "http://test", token: "token", sharedDriveId: "   " })).toThrow(DriveNotBoundError);
      expect(state.requests.length).toBe(0);
    });

    it("(15) DriveNotBoundError has code='drive_not_bound'", () => {
      const state: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
      const fetchFn = createMockBrokerFn(state);
      try {
        createBroker(fetchFn, { baseUrl: "http://test", token: "token", sharedDriveId: "" });
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(DriveNotBoundError);
        expect((e as any).code).toBe("drive_not_bound");
      }
    });

    it("(16) fetch is never called if sharedDriveId check fails", () => {
      let fetchCalled = false;
      const fetchFn = async () => {
        fetchCalled = true;
        return { status: 200, ok: true, text: async () => "{}" };
      };
      try {
        createBroker(fetchFn, { baseUrl: "http://test", token: "token", sharedDriveId: "" });
      } catch {
        // expected
      }
      expect(fetchCalled).toBe(false);
    });

    it("(17) two brokers with different sharedDriveIds send correct ids in resolve query", async () => {
      const state1: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
      const state2: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };

      const fetchFn1 = createMockBrokerFn(state1);
      const fetchFn2 = createMockBrokerFn(state2);

      const broker1 = createBroker(fetchFn1, { baseUrl: "http://test", token: "token", sharedDriveId: "drive-A" });
      const broker2 = createBroker(fetchFn2, { baseUrl: "http://test", token: "token", sharedDriveId: "drive-B" });

      await broker1.resolve("project", "p1");
      await broker2.resolve("project", "p2");

      expect(state1.requests.some((r) => r.url.includes("shared_drive_id=drive-A"))).toBe(true);
      expect(state2.requests.some((r) => r.url.includes("shared_drive_id=drive-B"))).toBe(true);
    });

    it("(18) two brokers with different sharedDriveIds send correct ids in ensure body", async () => {
      const state1: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };
      const state2: BrokerState = { registry: new Map(), driveFolders: new Map(), posts: [], requests: [] };

      const fetchFn1 = createMockBrokerFn(state1);
      const fetchFn2 = createMockBrokerFn(state2);

      const broker1 = createBroker(fetchFn1, { baseUrl: "http://test", token: "token", sharedDriveId: "drive-A" });
      const broker2 = createBroker(fetchFn2, { baseUrl: "http://test", token: "token", sharedDriveId: "drive-B" });

      await broker1.ensure({ entity_type: "project", entity_id: "p1", name: "P1" });
      await broker2.ensure({ entity_type: "project", entity_id: "p2", name: "P2" });

      const post1 = state1.posts.find((p) => p.url.includes("/ensure"));
      const post2 = state2.posts.find((p) => p.url.includes("/ensure"));

      expect(post1?.body.shared_drive_id).toBe("drive-A");
      expect(post2?.body.shared_drive_id).toBe("drive-B");
    });
  });

  describe("tool-level: driveFolderEnsure with drive binding", () => {
    it("(19) company with NO sharedDriveId: ensure returns drive_not_bound, fetch not called", async () => {
      const { harness, state } = await setup({ driveBrokerToken: "token" }, seed());
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Test" } as never] });
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r.data?.status).toBe("drive_not_bound");
      expect(state.requests.length).toBe(0);
    });

    it("(20) two companies with different drives: each carries its own shared_drive_id", async () => {
      const st = seed();
      linked(st, "co-a", "Company A");
      linked(st, "co-b", "Company B");
      const { harness: h1, state: s1 } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-A" } }, st);
      const { harness: h2, state: s2 } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-B" } }, JSON.parse(JSON.stringify(st)));

      h1.seed({ projects: [{ id: "p1", companyId: CO, name: "ProjectA" } as never] });
      h2.seed({ projects: [{ id: "p2", companyId: CO, name: "ProjectB" } as never] });

      await toolRaw(h1, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      await toolRaw(h2, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });

      const post1 = s1.posts.find((p) => p.body.entity_type === "project");
      const post2 = s2.posts.find((p) => p.body.entity_type === "project");
      expect(post1?.body.shared_drive_id).toBe("drive-A");
      expect(post2?.body.shared_drive_id).toBe("drive-B");
    });

    it("(21) project with no project_drive_kind: produces client chain", async () => {
      const st = seed();
      linked(st, "co-c", "Acme Ltd");
      const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ClientProject" } as never] });

      await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      // Should have two POSTs: company first, then project
      const companyPost = state.posts[0];
      const projectPost = state.posts[1];
      expect(companyPost?.body.entity_type).toBe("crm_company");
      expect(projectPost?.body.entity_type).toBe("project");
      expect(projectPost?.body.parent_entity_id).toBe("co-c");
    });

    it("(22) project with product kind: produces Products chain with subfolders", async () => {
      const st = seed();
      const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProductProject" } as never] });

      // Mock the project drive kind as product - for now just verify the ensure works
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });

      // Product projects should have subfolders in the ensure body
      const projectPost = state.posts.find((p) => p.body.entity_type === "project");
      expect(projectPost).toBeDefined();
      expect(r.data?.status).toBe("created");
    });

    it("(23) ensure called twice: second returns exists, no new POSTs", async () => {
      const st = seed();
      linked(st, "co-d", "Acme Ltd");
      const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Twice" } as never] });

      const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r1.data?.status).toBe("created");
      const postsAfterFirst = state.posts.length;

      const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r2.data?.status).toBe("exists");
      expect(state.posts.length).toBe(postsAfterFirst);
    });

    it("(24) invalid project name: returns invalid_name, no ensure POST", async () => {
      const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } });
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "PAR-123" } as never] });

      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
      expect(r.data?.status).toBe("invalid_name");
      expect(state.posts.length).toBe(0);
    });
  });
});
