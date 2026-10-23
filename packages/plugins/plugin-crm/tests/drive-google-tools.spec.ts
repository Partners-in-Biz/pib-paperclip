import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { resolveProducerSaveProject } from "../src/drive/tools.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

/** The tool layer on the native path: a service account key in the CRM settings, Google (faked) as the only server. */
async function setup(config: Record<string, unknown> = {}, google = fakeGoogle()) {
  const st = seed();
  st.companies!.push(company("co-a", "Acme Ltd"));
  st.contacts!.push(contact("contact-a", "Primary Contact"));
  st.contact_companies!.push({ id: "cc-a", company_id: CO, contact_id: "contact-a", account_id: "co-a", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  st.client_projects!.push({ id: "cp-1", company_id: CO, project_id: "p-seo", client_kind: "company", client_ref: "co-a", kind: "seo", created_at: "2026-01-01T00:00:00Z" });
  st.client_projects!.push({ id: "cp-2", company_id: CO, project_id: "p-web", client_kind: "company", client_ref: "co-a", kind: "website", created_at: "2026-01-02T00:00:00Z" });
  const { harness } = await boot({ config: { driveServiceAccountJson: KEY_JSON, drive: { sharedDriveId: DRIVE_ID }, ...config }, store: st });
  harness.seed({ projects: [{ id: "p-seo", companyId: CO, name: "Acme SEO" } as never, { id: "p-web", companyId: CO, name: "Acme Website" } as never] });
  // The legacy broker goes through ctx.http.fetch; the native path must never touch it.
  const legacy = vi.fn(async () => ({ status: 500, ok: false, text: async () => "{}" }));
  harness.ctx.http.fetch = legacy as never;
  vi.stubGlobal("fetch", google.fetchFn);
  return { harness, google, legacy };
}

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("Drive tools on the native service-account path", () => {
  it("drive_folder_ensure builds Client → Project → numbered sub-folders in the Shared Drive, then reports exists", async () => {
    const { harness, google, legacy } = await setup();
    const r1 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-seo" });
    expect(r1.data?.status).toBe("created");
    expect(r1.data?.path).toBe("Acme Ltd (Primary Contact)/Acme SEO");
    const names = google.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Acme Ltd (Primary Contact)", "Acme SEO", "01 Briefs", "02 Assets", "05 Evidence", "99 Archive"]));
    const count = google.files.length;
    const r2 = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-seo" });
    expect(r2.data?.status).toBe("exists");
    expect(google.files.length).toBe(count);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("drive_folder_resolve reports not_found, then found with the folder URL", async () => {
    const { harness } = await setup();
    expect((await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" })).data?.status).toBe("not_found");
    await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-seo" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(r.data?.status).toBe("found");
    expect(r.data?.url).toContain("drive.google.com");
  });

  it("drive_binding_status asks Google: service account email and Shared Drive membership, no legacy call", async () => {
    const member = await setup({}, fakeGoogle({ member: true }));
    const ok = await toolRaw(member.harness, "drive_binding_status", {});
    expect(ok.data).toMatchObject({ bound: true, tokenSet: true, serviceAccountIsMember: true, serviceAccountEmail: "drive-sa@proj.iam.gserviceaccount.com" });
    expect(member.legacy).not.toHaveBeenCalled();
    clearServiceAccountTokenCache();
    const stranger = await setup({}, fakeGoogle({ member: false }));
    const no = await toolRaw(stranger.harness, "drive_binding_status", {});
    expect(no.data).toMatchObject({ tokenSet: true, serviceAccountIsMember: false, serviceAccountEmail: "drive-sa@proj.iam.gserviceaccount.com" });
  });

  it("a non-member service account fails the ensure with the fix named", async () => {
    const { harness } = await setup({}, fakeGoogle({ filesStatus: 403 }));
    const r = await toolRaw(harness, "drive_folder_ensure", { entity_type: "project", entity_id: "p-seo" });
    expect(JSON.stringify(r)).toMatch(/Content manager/);
  });
});

describe("resolveProducerSaveProject (producer plugin saves)", () => {
  it("a client's save goes to the project of the same kind, else the client's oldest project", async () => {
    const { harness } = await setup();
    expect(await resolveProducerSaveProject(harness.ctx, CO, { kind: "seo", clientKind: "company", clientRef: "co-a" })).toBe("p-seo");
    expect(await resolveProducerSaveProject(harness.ctx, CO, { kind: "social", clientKind: "company", clientRef: "co-a" })).toBe("p-seo");
    expect(await resolveProducerSaveProject(harness.ctx, CO, { kind: "website", clientKind: "company", clientRef: "co-a" })).toBe("p-web");
  });

  it("a client with no linked project, or an unknown client kind, has no project (no guess)", async () => {
    const { harness } = await setup();
    expect(await resolveProducerSaveProject(harness.ctx, CO, { kind: "seo", clientKind: "company", clientRef: "nobody" })).toBeNull();
    expect(await resolveProducerSaveProject(harness.ctx, CO, { kind: "seo", clientKind: "robot", clientRef: "co-a" })).toBeNull();
  });

  it("own work goes to drive.ownProjectId when set, else nowhere", async () => {
    const without = await setup();
    expect(await resolveProducerSaveProject(without.harness.ctx, CO, { kind: "social" })).toBeNull();
    const withOwn = await setup({ drive: { sharedDriveId: DRIVE_ID, ownProjectId: " p-web " } });
    expect(await resolveProducerSaveProject(withOwn.harness.ctx, CO, { kind: "social" })).toBe("p-web");
  });
});
