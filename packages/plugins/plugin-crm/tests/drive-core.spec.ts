import { describe, expect, it } from "vitest";
import { checkFolderName, folderKey, type NameProblem } from "../src/drive/names.js";
import { createBroker, BrokerError, type FetchLike } from "../src/drive/broker.js";
import { companyFolderName, planFolders } from "../src/drive/convention.js";

describe("names", () => {
  const testCases: Array<[string, NameProblem | null]> = [
    ["", "empty"],
    ["550e8400-e29b-41d4-a716-446655440000", "uuid"],
    ["PAR-123", "issue_key"],
    ["1AbCdEfGhIjKlMnOpQrStUvWxYz012335", "drive_id"],
    ["https://drive.google.com/drive/...", "drive_id"],
    ["hello/world", "illegal_chars"],
    ["hello\\world", "illegal_chars"],
    ["internationalization", null],
    ["my-long-project-name-here", null],
    ["Acme Corp (Jane Doe)", null],
  ];

  it.each(testCases)('validates "%s" → %s', (input, expected) => {
    expect(checkFolderName(input)).toBe(expected);
  });

  it("folderKey equivalence: Café Plan = Cafe Plan", () => {
    expect(folderKey("Café Plan")).toBe(folderKey("Cafe Plan"));
  });
});

describe("broker", () => {
  it("502 parses folderId and path and is retryable", async () => {
    const fetch: FetchLike = async () => ({
      status: 502,
      ok: false,
      text: async () => '{"error":"failed (folderId: f123) (path: /Parent/Child)"}',
    });
    const broker = createBroker(fetch, { baseUrl: "http://localhost:3000", token: "test" });
    try {
      await broker.resolve("project", "p1");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      const e = err as BrokerError;
      expect(e.retryable).toBe(true);
      expect(e.folderId).toBe("f123");
      expect(e.path).toBe("/Parent/Child");
    }
  });

  it("403 and 503 are not retryable", async () => {
    for (const status of [403, 503]) {
      const fetch: FetchLike = async () => ({ status, ok: false, text: async () => '{"error":"test"}' });
      const broker = createBroker(fetch, { baseUrl: "http://localhost:3000", token: "test" });
      try {
        await broker.resolve("project", "p1");
      } catch (err) {
        expect((err as BrokerError).retryable).toBe(false);
      }
    }
  });

  it("token never appears in error messages", async () => {
    const fetch: FetchLike = async () => ({ status: 500, ok: false, text: async () => '{"error":"fail"}' });
    const broker = createBroker(fetch, { baseUrl: "http://localhost:3000", token: "super-secret-12345" });
    try {
      await broker.resolve("project", "p1");
    } catch (err) {
      expect((err as BrokerError).message).not.toContain("super-secret");
    }
  });
});

describe("convention", () => {
  it("companyFolderName with/without contact", () => {
    expect(companyFolderName("Acme Corp", "Jane Doe")).toBe("Acme Corp (Jane Doe)");
    expect(companyFolderName("Acme Corp")).toBe("Acme Corp");
  });

  it("planFolders: project without company has 1 step", () => {
    const plan = planFolders({ entityType: "project", entityId: "p1", name: "Standalone" }, []);
    expect(plan.kind).toBe("ensure");
    if (plan.kind === "ensure") {
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].entity_type).toBe("project");
      expect(plan.steps[0].parent_entity_id).toBeUndefined();
    }
  });

  it("planFolders: invalid name rejects UUID, issue key, Drive ID", () => {
    for (const name of ["550e8400-e29b-41d4-a716-446655440000", "PAR-123", "1AbCdEfGhIjKlMnOpQrStUvWxYz012335"]) {
      const plan = planFolders({ entityType: "crm_company", entityId: "c1", name }, []);
      expect(plan.kind).toBe("invalid_name");
    }
  });
});
