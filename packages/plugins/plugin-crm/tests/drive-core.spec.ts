import { beforeEach, describe, expect, it } from "vitest";
import { checkFolderName, folderKey, type NameProblem } from "../src/drive/names.js";
import { BrokerError } from "../src/drive/broker.js";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { clearServiceAccountTokenCache, parseServiceAccountKey } from "../src/drive/google-sa.js";
import { companyFolderName, planFolders } from "../src/drive/convention.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

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

describe("broker error mapping and secrecy", () => {
  const broker = (g: ReturnType<typeof fakeGoogle>) => createGoogleDriveBroker(g.fetchFn, parseServiceAccountKey(KEY_JSON), DRIVE_ID);

  beforeEach(() => clearServiceAccountTokenCache());

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])("a Drive call answered %i is a BrokerError with retryable=%s", async (status, retryable) => {
    const err = await broker(fakeGoogle({ filesStatus: status })).resolve("project", "p1").catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).status).toBe(status);
    expect((err as BrokerError).retryable).toBe(retryable);
  });

  it("the access token and the private key never appear in error messages (Drive error, refused key, network error)", async () => {
    const privateKey = (JSON.parse(KEY_JSON) as { private_key: string }).private_key;
    const failures: Array<() => Promise<unknown>> = [
      () => broker(fakeGoogle({ filesStatus: 500 })).resolve("project", "p1"),
      () => broker(fakeGoogle({ filesStatus: 401 })).resolve("project", "p1"),
      () => broker(fakeGoogle({ uploadStatus: 500 })).uploadFile({ name: "a.txt", bytes: new Uint8Array([1]), mimeType: "text/plain" }),
      () => createGoogleDriveBroker(async () => { throw new Error("socket hang up"); }, parseServiceAccountKey(KEY_JSON), DRIVE_ID).resolve("project", "p1"),
      () => broker(fakeGoogle({ tokenStatus: 400 })).resolve("project", "p1"),
    ];
    for (const failure of failures) {
      clearServiceAccountTokenCache();
      const err = (await failure().catch((e) => e)) as BrokerError;
      expect(err).toBeInstanceOf(BrokerError);
      expect(err.message).not.toContain("ya29.fake");
      expect(err.message).not.toContain("PRIVATE KEY");
      expect(err.message).not.toContain(privateKey.slice(40, 80));
      expect(JSON.stringify(err)).not.toContain("ya29.fake");
    }
  });

  it("a refused key is a bad credential that says so, a Drive 5xx is not", async () => {
    expect(await broker(fakeGoogle({ tokenStatus: 400 })).resolve("project", "p1").catch((e) => e)).toMatchObject({ code: "bad_credential", retryable: false });
    clearServiceAccountTokenCache();
    expect(await broker(fakeGoogle({ filesStatus: 503 })).resolve("project", "p1").catch((e) => e)).toMatchObject({ retryable: true, code: undefined });
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
