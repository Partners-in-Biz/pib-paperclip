import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createGoogleDriveBroker } from "../src/drive/google-broker.js";
import { BrokerError, DriveNotBoundError } from "../src/drive/broker.js";
import { clearServiceAccountTokenCache, parseServiceAccountKey } from "../src/drive/google-sa.js";
import { planFolders, DRIVE_SUBFOLDERS } from "../src/drive/convention.js";

import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

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
    expect(company.folder.path).toBe("Acme");
    const project = await b.ensure({ entity_type: "project", entity_id: "p1", name: "Acme Website", parent_entity_id: "co1", subfolders: [...DRIVE_SUBFOLDERS] });
    expect(project.created).toBe(true);
    expect(project.folder.path).toBe("Acme/Acme Website");
    expect(project.tree.map((t) => t.path)).toEqual(DRIVE_SUBFOLDERS.map((s) => `Acme/Acme Website/${s}`));
    expect(project.tree.every((t) => t.created)).toBe(true);

    const found = await b.resolve("project", "p1");
    expect(found?.folder_id).toBe(project.folder.folder_id);
    expect(found?.path).toBe("Acme/Acme Website");
    expect(await b.resolve("project", "nope")).toBeNull();
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
    expect(last!.folder.path).toBe("Books/Cool Book");
    expect(last!.tree).toHaveLength(DRIVE_SUBFOLDERS.length);
  });

  it("adopts a same-named untagged folder (made by the old broker) instead of duplicating", async () => {
    const g = fakeGoogle();
    g.files.push({ id: "old1", name: "Acme", mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_ID] });
    const r = await broker(g).ensure({ entity_type: "crm_company", entity_id: "co1", name: "Acme" });
    expect(r.created).toBe(false);
    expect(r.folder.folder_id).toBe("old1");
    expect(g.files).toHaveLength(1);
    expect((await broker(g).resolve("crm_company", "co1"))?.folder_id).toBe("old1");
  });

  it("back-fills the complete tag on a folder made before the tag existed (no sub-folders to wait for)", async () => {
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

describe("parseServiceAccountKey", () => {
  it("rejects non-JSON, non-service-account and keyless input", () => {
    expect(() => parseServiceAccountKey("nope")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toThrow(/not a service account/);
    expect(() => parseServiceAccountKey(JSON.stringify({ type: "service_account", client_email: "a@b" }))).toThrow(/no client_email or private_key/);
  });
});
