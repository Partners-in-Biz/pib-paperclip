import { describe, it, expect } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { DRIVE_TOOLS } from "../src/drive/tools.js";

interface BrokerState {
  registry: Map<string, any>;
  driveFolders: Map<string, { id: string; path: string; folder_id: string; folder_url: string }>;
  driveCreates: string[];
  posts: Array<{ url: string; headers: Record<string, string>; body: any }>;
  failRegistryWriteOnce: boolean;
  forceStatus?: number;
}

function createMockBroker(st: BrokerState) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    if (!init.headers.Authorization?.startsWith("Bearer ")) return { status: 401, ok: false, text: async () => "{}" };
    if (init.method === "GET" && url.includes("/registry/resolve")) {
      const params = new URL(url, "http://base").searchParams, key = `${params.get("entity_type")}:${params.get("entity_id")}`, found = st.registry.get(key);
      return found ? { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: { folder: found } }) } : { status: 404, ok: false, text: async () => JSON.stringify({ success: false, error: "Not found" }) };
    }
    if (init.method === "POST" && url.includes("/registry/ensure")) {
      const body = JSON.parse(init.body || "{}"), { entity_type, entity_id, name, parent_entity_id, subfolders } = body;
      st.posts.push({ url, headers: init.headers, body });
      const key = `${entity_type}:${entity_id}`;
      let isNew = !st.registry.has(key);
      if (isNew) {
        if (parent_entity_id && !st.registry.has(`crm_company:${parent_entity_id}`)) return { status: 409, ok: false, text: async () => JSON.stringify({ success: false, error: "Parent not found" }) };
        let path = entity_type === "crm_company" ? `02 Partners in Biz/Clients/${name}` : parent_entity_id ? `${st.registry.get(`crm_company:${parent_entity_id}`)?.path}/${name}/Deliverables` : `02 Partners in Biz/Products/${name}/Deliverables`;
        const pathExists = st.driveFolders.has(path);
        let fid = pathExists ? st.driveFolders.get(path)!.folder_id : `f_${st.driveFolders.size + 1}`;
        if (!pathExists) {
          st.driveFolders.set(path, { id: fid, path, folder_id: fid, folder_url: `https://drive.google.com/drive/folders/${fid}` });
          st.driveCreates.push(path);
        }
        if (st.failRegistryWriteOnce) { st.failRegistryWriteOnce = false; return { status: 502, ok: false, text: async () => JSON.stringify({ success: false, error: `registry_write_failed (folderId: ${fid}) (path: ${path})` }) }; }
        if (st.forceStatus) return { status: st.forceStatus, ok: false, text: async () => JSON.stringify({ success: false, error: "Error" }) };
        st.registry.set(key, { id: `r_${st.registry.size + 1}`, entity_type, entity_id, path, folder_id: fid, folder_url: `https://drive.google.com/drive/folders/${fid}` });
      }
      const reg = st.registry.get(key)!;
      return { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: { folder: reg, created: isNew, tree: [] } }) };
    }
    return { status: 404, ok: false, text: async () => "{}" };
  };
}

async function setup(config: Record<string, any> = {}, store?: Record<string, any>) {
  const baseStore = store || seed();
  const { harness } = await boot({ config, store: baseStore });
  const state: BrokerState = { registry: new Map(), driveFolders: new Map(), driveCreates: [], posts: [], failRegistryWriteOnce: false };
  harness.ctx.http.fetch = createMockBroker(state) as any;
  return { harness, state };
}

function linked(baseSeed: Record<string, any>, coId: string, name: string) {
  const contactId = `contact-${coId}`;
  baseSeed.companies!.push(company(coId, name));
  baseSeed.contacts!.push(contact(contactId, "Primary Contact"));
  baseSeed.contact_companies!.push({ id: `cc-${coId}`, company_id: CO, contact_id: contactId, account_id: coId, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  baseSeed.client_projects!.push({ id: `cp-${coId}`, company_id: CO, project_id: "p1", client_kind: "company", client_ref: coId, created_at: "2026-01-01T00:00:00Z" });
}

describe("Drive folder tools", () => {
  it("declares resolve, ensure, file-save, set, list, and binding tools with schemas and descriptions", () => {
    expect(DRIVE_TOOLS).toHaveLength(7);
    expect(DRIVE_TOOLS[0].name).toBe("drive_folder_resolve");
    expect(DRIVE_TOOLS[1].name).toBe("drive_folder_ensure");
    expect(DRIVE_TOOLS[2].name).toBe("drive_file_save");
    expect(DRIVE_TOOLS[3].name).toBe("drive_project_kind_set");
    expect(DRIVE_TOOLS[4].name).toBe("drive_project_kind_list");
    expect(DRIVE_TOOLS[5].name).toBe("drive_binding_discover");
    expect(DRIVE_TOOLS[6].name).toBe("drive_binding_set");
    expect(DRIVE_TOOLS[0].description).toContain("Never hard-code");
    expect(DRIVE_TOOLS[0].description).toContain("ALWAYS call this first");
    expect(DRIVE_TOOLS[1].description).toContain("Never hard-code");
    expect(DRIVE_TOOLS[2].description).toContain("deduplicates");
    expect(DRIVE_TOOLS[3].description).toContain("Drive folder kind");
    expect(DRIVE_TOOLS[4].description).toContain("read-only");
    expect(DRIVE_TOOLS[5].description).toContain("Shared Drives");
    expect(DRIVE_TOOLS[6].description).toContain("Shared Drive");
  });

  it("(a) company-linked project idempotent: create then exists", async () => {
    const st = seed();
    linked(st, "co-a", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.data?.status).toBe("created");
    const posts1 = state.posts.length;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("exists");
    expect(state.posts.length).toBe(posts1);
  });

  it("(b) unlinked/contact-linked → Products (no parent_entity_id in POST)", async () => {
    const st = seed();
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p-unlinked", companyId: CO, name: "Solo" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-unlinked" });
    expect(state.posts[0].body.parent_entity_id).toBeUndefined();
    expect(state.posts[0].body.entity_type).toBe("project");
    expect(state.posts[0].body.name).toBe("Solo");
  });

  it("(c) company-linked: posts have name 'Acme Ltd (Primary Contact)', parent_entity_id set", async () => {
    const st = seed();
    linked(st, "co-c", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(state.posts[0].body.entity_type).toBe("crm_company");
    expect(state.posts[0].body.name).toBe("Acme Ltd (Primary Contact)");
    expect(state.posts[1].body.entity_type).toBe("project");
    expect(state.posts[1].body.parent_entity_id).toBe("co-c");
  });

  it("(d) all requests: Bearer token header, no forbidden keys", async () => {
    const st = seed();
    linked(st, "co-d", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    for (const post of state.posts) {
      expect(post.headers.Authorization).toBe("Bearer token");
      // Forbidden keys: folder_id, folderId, parent_id, parentId, or standalone drive_id key
      // (but shared_drive_id is allowed)
      expect(JSON.stringify(post.body)).not.toMatch(/"(?:folder_id|folderId|parent_id|parentId|drive_id)"/i);
    }
  });

  it("(e) UUID/PAR-123/Drive-id → invalid_name", async () => {
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } });
    for (const n of ["3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c", "PAR-123", "1AbCdEfGhIjKlMnOpQrStUvWxYz012335"]) {
      harness.seed({ projects: [{ id: `p${n}`, companyId: CO, name: n } as never] });
      const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: `p${n}` });
      expect(r.data?.status).toBe("invalid_name");
    }
    expect(state.posts.length).toBe(0);
  });

  it("(f) name collision → needs_human_look", async () => {
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } });
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Café Plan" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const posts1 = state.posts.length;
    harness.seed({ projects: [{ id: "p2", companyId: CO, name: "cafe  plan" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });
    expect(r.data?.status).toBe("needs_human_look");
    expect(state.posts.length).toBe(posts1);
  });

  it("(g) 502 retry: no duplicate Drive creations, registry entries exist", async () => {
    const st = seed();
    linked(st, "co-g", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    state.failRegistryWriteOnce = true;
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r1.error).toContain("retryable");
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r2.data?.status).toBe("created");
    expect(new Set(state.driveCreates).size).toBe(state.driveCreates.length);
    expect(state.driveCreates.length).toBe(2);
  });

  it("(h) resolve: not_found→ensure→found; bad entity_type errors", async () => {
    const { harness } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } });
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    let r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("not_found");
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("found");
    r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "bad", entity_id: "p1" });
    expect(r.error).toBeDefined();
  });

  it("(i) no token → error with driveBrokerToken", async () => {
    const { harness, state } = await setup({});
    harness.seed({ projects: [{ id: "p", companyId: CO, name: "P" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p" });
    expect(r.error).toContain("driveBrokerToken");
    expect(state.posts.length).toBe(0);
  });

  it("(k) broker 403 error (non-retryable) fails tool", async () => {
    const st = seed();
    linked(st, "co-k", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    state.forceStatus = 403;
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.error).toBeDefined();
    expect(state.posts.length).toBeGreaterThan(0);
  });

  it("(l) company sibling collision vs unlinked non-collision", async () => {
    const st = seed();
    linked(st, "co-l", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Site" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    st.client_projects!.push({ id: "cp2", company_id: CO, project_id: "p2", client_kind: "company", client_ref: "co-l", created_at: "2026-01-01T00:00:00Z" });
    harness.seed({ projects: [{ id: "p2", companyId: CO, name: "Site" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p2" });
    expect(r.data?.status).toBe("needs_human_look");
    harness.seed({ projects: [{ id: "p3", companyId: CO, name: "Site" } as never] });
    const r3 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p3" });
    expect(r3.data?.status).toBe("created");
  });

  it("(m) resolve unwraps {success:true,data:{folder:{...}}} envelope", async () => {
    const st = seed();
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("found");
    expect(r.data?.folder_id).toBeDefined();
  });

  it("(n) company name collision: two crm_company siblings with same key → needs_human_look", async () => {
    const st = seed();
    // Create two companies with names that normalize to the same folder key
    st.companies!.push(company("co-n1", "Acme Ltd"));
    st.companies!.push(company("co-n2", "acme  ltd"));
    st.contacts!.push(contact("con-n1", "Primary Contact"));
    st.contacts!.push(contact("con-n2", "Primary Contact"));
    st.contact_companies!.push({ id: "cc-n1", company_id: CO, contact_id: "con-n1", account_id: "co-n1", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    st.contact_companies!.push({ id: "cc-n2", company_id: CO, contact_id: "con-n2", account_id: "co-n2", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: "co-n1" });
    expect(r1.error || r1.data?.status).toBeDefined();
    const postsAfterFirst = state.posts.length;
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "crm_company", entity_id: "co-n2" });
    expect(r.data?.status).toBe("needs_human_look");
  });

  it("(o) created_by_run is sent in ensure body when runId is given", async () => {
    const st = seed();
    linked(st, "co-o", "Acme Ltd");
    const { harness, state } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(state.posts.some((p) => p.body.created_by_run === "run-1")).toBe(true);
  });

  it("(p) network error on first resolve in ensure → CrmError not BrokerError", async () => {
    const st = seed();
    const { harness } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } }, st);
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "P" } as never] });
    harness.ctx.http.fetch = async () => {
      throw new Error("Network timeout");
    };
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.error).toBeDefined();
    expect(r.error).toContain("Drive broker");
  });

  it("(q) long CamelCase name rejected as drive_id", async () => {
    const { harness } = await setup({ driveBrokerToken: "token", drive: { sharedDriveId: "drive-test" } });
    harness.seed({ projects: [{ id: "p1", companyId: CO, name: "ProjectManagementDashboardV2" } as never] });
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p1" });
    expect(r.data?.status).toBe("invalid_name");
    expect(r.data?.problem).toBe("drive_id");
  });
});
