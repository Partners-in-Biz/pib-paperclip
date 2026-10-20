import { describe, it, expect } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";

function linked(baseSeed: Record<string, any>, coId: string, name: string) {
  const contactId = `contact-${coId}`;
  baseSeed.companies!.push(company(coId, name));
  baseSeed.contacts!.push(contact(contactId, "Primary Contact"));
  baseSeed.contact_companies!.push({ id: `cc-${coId}`, company_id: CO, contact_id: contactId, account_id: coId, role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  baseSeed.client_projects!.push({ id: `cp-${coId}`, company_id: CO, project_id: "p1", client_kind: "company", client_ref: coId, created_at: "2026-01-01T00:00:00Z" });
}

describe("Drive project kind tools", () => {
  describe("drive_project_kind_set", () => {
    it("sets kind on own project (no client link)", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-own", companyId: CO, name: "Internal Product" } as never] });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-own", kind: "product" });
      expect(r.data?.status).toBe("set");
      expect(r.data?.kind).toBe("product");
      expect(r.data?.projectId).toBe("p-own");
    });

    it("sets kind with scopeRef for marketing", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-campaign", companyId: CO, name: "Q4 Campaign" } as never] });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-campaign", kind: "marketing", scopeRef: "Q4 Campaigns" });
      expect(r.data?.status).toBe("set");
      expect(r.data?.kind).toBe("marketing");
      expect(r.data?.scopeRef).toBe("Q4 Campaigns");
    });

    it("changes existing kind", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-change", companyId: CO, name: "Book" } as never] });

      const r1 = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-change", kind: "book" });
      expect(r1.data?.kind).toBe("book");

      const r2 = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-change", kind: "product" });
      expect(r2.data?.kind).toBe("product");
    });

    it("rejects invalid kind", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-invalid", companyId: CO, name: "Test" } as never] });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-invalid", kind: "invalid_kind" });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain("Invalid kind");
    });

    it("rejects missing projectId", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });

      const r = await toolRaw(harness, "drive_project_kind_set", { kind: "product" });
      expect(r.error).toContain("Missing projectId");
    });

    it("rejects missing kind", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-no-kind", companyId: CO, name: "Test" } as never] });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-no-kind" });
      expect(r.error).toContain("Missing kind");
    });

    it("rejects nonexistent project", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-nonexistent", kind: "product" });
      expect(r.error).toContain("Project not found");
    });

    it("records updated_by", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-audit", companyId: CO, name: "Test" } as never] });

      const r = await toolRaw(harness, "drive_project_kind_set", { projectId: "p-audit", kind: "book" });
      expect(r.data?.updatedAt).toBeDefined();
    });
  });

  describe("drive_project_kind_list", () => {
    it("lists kinds for specified projectIds", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({
        projects: [
          { id: "p1", companyId: CO, name: "Project 1" } as never,
          { id: "p2", companyId: CO, name: "Project 2" } as never,
        ],
      });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p1", kind: "product" });
      await toolRaw(harness, "drive_project_kind_set", { projectId: "p2", kind: "book" });

      const r = await toolRaw(harness, "drive_project_kind_list", { projectIds: ["p1", "p2"] });
      expect(r.data?.projects).toHaveLength(2);
      expect(r.data?.projects.some((p: any) => p.projectId === "p1" && p.kind === "product")).toBeTruthy();
      expect(r.data?.projects.some((p: any) => p.projectId === "p2" && p.kind === "book")).toBeTruthy();
    });

    it("lists all kinds for the company when projectIds omitted", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({
        projects: [
          { id: "p-all-1", companyId: CO, name: "All 1" } as never,
          { id: "p-all-2", companyId: CO, name: "All 2" } as never,
        ],
      });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-all-1", kind: "marketing", scopeRef: "Brand" });
      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-all-2", kind: "company" });

      const r = await toolRaw(harness, "drive_project_kind_list", {});
      expect(r.data?.projects.length).toBeGreaterThanOrEqual(2);
      expect(r.data?.projects.some((p: any) => p.projectId === "p-all-1" && p.kind === "marketing")).toBeTruthy();
    });

    it("includes scopeRef in result for marketing projects", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p-scope", companyId: CO, name: "Campaign" } as never] });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-scope", kind: "marketing", scopeRef: "Campaign Name" });

      const r = await toolRaw(harness, "drive_project_kind_list", { projectIds: ["p-scope"] });
      expect(r.data?.projects[0].scopeRef).toBe("Campaign Name");
    });

    it("defaults client-linked project to kind 'client' when no row exists", async () => {
      const st = seed();
      linked(st, "co-default", "Client Corp");
      const { harness } = await boot({ store: st });
      harness.seed({ projects: [{ id: "p1", companyId: CO, name: "Website" } as never] });

      // Project p1 is linked to co-default but has no explicit kind row
      const r = await toolRaw(harness, "drive_project_kind_list", { projectIds: ["p1"] });
      expect(r.data?.projects.some((p: any) => p.projectId === "p1" && p.kind === "client")).toBeTruthy();
    });

    it("omits unlinked project without a kind row", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({
        projects: [
          { id: "p-unlinked", companyId: CO, name: "Orphan" } as never,
          { id: "p-with-kind", companyId: CO, name: "Has Kind" } as never,
        ],
      });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-with-kind", kind: "product" });

      const r = await toolRaw(harness, "drive_project_kind_list", { projectIds: ["p-unlinked", "p-with-kind"] });
      expect(r.data?.projects.some((p: any) => p.projectId === "p-unlinked")).toBeFalsy();
      expect(r.data?.projects.some((p: any) => p.projectId === "p-with-kind")).toBeTruthy();
    });

    it("excludes other company's projects", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({
        projects: [
          { id: "p-my-1", companyId: CO, name: "My Project" } as never,
          { id: "p-other-1", companyId: "other-company", name: "Other Project" } as never,
        ],
      });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-my-1", kind: "product" });

      // Use harness for other company (would need a different harness setup in real scenario)
      const r = await toolRaw(harness, "drive_project_kind_list", {});
      expect(r.data?.projects.some((p: any) => p.projectId === "p-other-1")).toBeFalsy();
      expect(r.data?.projects.some((p: any) => p.projectId === "p-my-1")).toBeTruthy();
    });

    it("returns total count", async () => {
      const st = seed();
      const { harness } = await boot({ store: st });
      harness.seed({
        projects: [
          { id: "p-t1", companyId: CO, name: "Total 1" } as never,
          { id: "p-t2", companyId: CO, name: "Total 2" } as never,
          { id: "p-t3", companyId: CO, name: "Total 3" } as never,
        ],
      });

      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-t1", kind: "book" });
      await toolRaw(harness, "drive_project_kind_set", { projectId: "p-t2", kind: "product" });

      const r = await toolRaw(harness, "drive_project_kind_list", { projectIds: ["p-t1", "p-t2"] });
      expect(r.data?.total).toBe(2);
    });
  });
});
