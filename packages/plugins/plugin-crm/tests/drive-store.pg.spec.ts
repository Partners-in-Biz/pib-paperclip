/** Migration 015 (drive tables) and drive store functions on real Postgres. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { insertAccount } from "../src/db.js";
import { createAccount } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { getDriveFile, getProjectDriveKind, listDriveFiles, listProjectDriveKinds, setProjectDriveKind, upsertDriveFile } from "../src/drive/store.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO_A = "co-a", CO_B = "co-b";
const sql015 = () => readFileSync(new URL("../migrations/015_crm.sql", import.meta.url), "utf8");
const available = await embeddedAvailable();

describe.skipIf(!available)("migration 015", () => {
  it("applies on fresh DB and populated DB; tables exist; existing rows untouched; twice harmless", async () => {
    const old = await startPg({ upTo: 14 });
    try {
      await old.client.query(`INSERT INTO ${NAMESPACE}.client_projects (id, company_id, client_kind, client_ref, project_id) VALUES ('l1', '${CO_A}', 'company', 'acme', 'p1')`);
      await old.client.query(sql015());
      await expect(old.client.query(sql015())).resolves.toBeDefined();
      expect((await old.client.query(`SELECT id FROM ${NAMESPACE}.client_projects WHERE id = 'l1'`)).rows).toHaveLength(1);
    } finally {
      await old.stop();
    }
    const fresh = await startPg();
    try {
      const pdk = await fresh.client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name = 'project_drive_kind'`);
      const df = await fresh.client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name = 'drive_files'`);
      expect(pdk.rows.length).toBe(1);
      expect(df.rows.length).toBe(1);
    } finally {
      await fresh.stop();
    }
  }, 120_000);
});

describe.skipIf(!available)("store functions", () => {
  let pg: PgHarness, ctx: PluginContext;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    ctx = pg.ctx;
    await insertAccount(ctx, createAccount({ companyId: CO_A, name: "A" }));
    await insertAccount(ctx, createAccount({ companyId: CO_B, name: "B" }));
  });

  it("upsertDriveFile: created=true then false, same id, 1 row", async () => {
    const input = { companyId: CO_A, projectId: "p1", kind: "c", folderId: "f1", name: "a.txt", sha256: "a".repeat(64), driveFileId: "d1", webUrl: "u", sourcePlugin: null };
    const r1 = await upsertDriveFile(ctx, input);
    const r2 = await upsertDriveFile(ctx, input);
    expect(r1.created && !r2.created && r1.file.id === r2.file.id).toBe(true);
    const count = (await pg.client.query(`SELECT count(*) FROM ${NAMESPACE}.drive_files WHERE company_id = $1`, [CO_A])).rows[0] as any;
    expect(Number(count.count)).toBe(1);
  });

  it("different sha256 or folder gives second row", async () => {
    const base = { companyId: CO_A, projectId: "p1", kind: "c", folderId: "f1", name: "n", driveFileId: "d", webUrl: "u", sourcePlugin: null };
    const r1 = await upsertDriveFile(ctx, { ...base, sha256: "b".repeat(64) });
    const r2 = await upsertDriveFile(ctx, { ...base, sha256: "c".repeat(64) });
    const r3 = await upsertDriveFile(ctx, { ...base, folderId: "f2", sha256: "b".repeat(64) });
    expect(r1.file.id !== r2.file.id && r1.file.id !== r3.file.id).toBe(true);
  });

  it("SQL-level unique (company_id, folder_id, name, sha256)", async () => {
    const input = { companyId: CO_A, projectId: "p1", kind: "c", folderId: "f1", name: "f.txt", sha256: "d".repeat(64), driveFileId: "d1", webUrl: "u", sourcePlugin: null };
    await upsertDriveFile(ctx, input);
    await expect(pg.client.query(`INSERT INTO ${NAMESPACE}.drive_files (id, company_id, project_id, kind, folder_id, name, sha256, drive_file_id, web_url, source_plugin) VALUES ('new', $1, $2, $3, $4, $5, $6, $7, $8, $9)`, [CO_A, "p1", "c", "f1", "f.txt", "d".repeat(64), "d1", "u", null])).rejects.toBeDefined();
  });

  it("company isolation files", async () => {
    const input = { projectId: "p1", kind: "c", folderId: "f1", name: "iso.txt", sha256: "e".repeat(64), driveFileId: "d", webUrl: "u", sourcePlugin: null };
    const a_id = (await upsertDriveFile(ctx, { ...input, companyId: CO_A })).file.id;
    await upsertDriveFile(ctx, { ...input, companyId: CO_B });
    expect(await getDriveFile(ctx, CO_A, a_id)).not.toBeNull();
    expect(await getDriveFile(ctx, CO_B, a_id)).toBeNull();
  });

  it("company isolation kinds", async () => {
    await setProjectDriveKind(ctx, { companyId: CO_A, projectId: "p1", kind: "client" });
    await setProjectDriveKind(ctx, { companyId: CO_B, projectId: "p1", kind: "product" });
    expect((await getProjectDriveKind(ctx, CO_A, "p1"))?.kind).toBe("client");
    expect((await getProjectDriveKind(ctx, CO_B, "p1"))?.kind).toBe("product");
  });

  it("own project no client link: set, overwrite, scopeRef null, list by ids and all", async () => {
    const r1 = await setProjectDriveKind(ctx, { companyId: CO_A, projectId: "own", kind: "root" });
    expect(r1.scopeRef).toBeNull();
    const r2 = await setProjectDriveKind(ctx, { companyId: CO_A, projectId: "own", kind: "book", scopeRef: "ref1" });
    expect(r2.kind).toBe("book");
    await setProjectDriveKind(ctx, { companyId: CO_A, projectId: "p2", kind: "k2" });
    const all = await listProjectDriveKinds(ctx, CO_A);
    const subset = await listProjectDriveKinds(ctx, CO_A, ["own", "p2"]);
    expect(all.map(k => k.projectId).sort()).toEqual(["own", "p2"]);
    expect(subset).toHaveLength(2);
  });

  it("invalid sha256 throws", async () => {
    await expect(upsertDriveFile(ctx, { companyId: CO_A, projectId: "p1", kind: "c", folderId: "f", name: "n", sha256: "bad", driveFileId: "d", webUrl: "u", sourcePlugin: null })).rejects.toThrow(/must be exactly 64/);
  });

  it("listDriveFiles: company filter, projectId filter, newest first, company B sees nothing", async () => {
    const base = { projectId: "p1", kind: "c", folderId: "f1", driveFileId: "d", webUrl: "u", sourcePlugin: null };
    const f1 = await upsertDriveFile(ctx, { ...base, companyId: CO_A, name: "1.txt", sha256: "1".repeat(64) });
    await new Promise(r => setTimeout(r, 10));
    const f2 = await upsertDriveFile(ctx, { ...base, companyId: CO_A, name: "2.txt", sha256: "2".repeat(64) });
    const f3 = await upsertDriveFile(ctx, { ...base, companyId: CO_A, projectId: "p2", name: "3.txt", sha256: "3".repeat(64) });
    await upsertDriveFile(ctx, { ...base, companyId: CO_B, name: "4.txt", sha256: "4".repeat(64) });
    const all = await listDriveFiles(ctx, CO_A);
    const p1 = await listDriveFiles(ctx, CO_A, { projectId: "p1" });
    const none = await listDriveFiles(ctx, CO_B);
    expect(all.map(f => f.name)).toEqual(["3.txt", "2.txt", "1.txt"]);
    expect(p1.map(f => f.name)).toEqual(["2.txt", "1.txt"]);
    expect(none).toHaveLength(1);
  });
});
