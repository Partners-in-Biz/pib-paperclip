import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireServerLock,
  ServerLockHeldError,
  SERVER_LOCK_APPLICATION_NAME,
  withServerLockForScript,
  type ServerLockHandle,
} from "./server-lock.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const quiet = { info: () => {}, error: () => {} };
const fast = { retryMs: 0, log: quiet, checkIntervalMs: 60_000 };

describePostgres("single-server lock", () => {
  let database: EmbeddedPostgresTestDatabase;
  let admin: ReturnType<typeof postgres>;
  const held: ServerLockHandle[] = [];

  async function take(options = {}): Promise<ServerLockHandle> {
    const handle = await acquireServerLock(database.connectionString, { ...fast, ...options });
    held.push(handle);
    return handle;
  }

  async function releaseAll(): Promise<void> {
    for (const handle of held.splice(0)) await handle.release();
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-server-lock-");
    admin = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await releaseAll();
    await admin?.end();
    await database?.cleanup();
  });

  it("refuses a second server while the first holds the lock, and lets one in afterwards", async () => {
    const first = await take();
    expect(first.state()).toBe("held");
    await expect(acquireServerLock(database.connectionString, fast)).rejects.toBeInstanceOf(ServerLockHeldError);
    await first.release();
    const second = await take();
    expect(second.state()).toBe("held");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("says how to fix it, and names who holds the lock", async () => {
    await take();
    const error = await acquireServerLock(database.connectionString, fast).catch((caught) => caught);
    expect(error.code).toBe("SERVER_LOCK_HELD");
    expect(error.message).toMatch(/database backend \d+/);
    expect(error.message).toContain("env -i");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("retries for the window, so a restart overlapping the old process still starts", async () => {
    const first = await take();
    const started = Date.now();
    const pending = acquireServerLock(database.connectionString, { ...fast, retryMs: 10_000, retryIntervalMs: 100 });
    setTimeout(() => void first.release(), 400);
    const second = await pending;
    held.push(second);
    expect(second.state()).toBe("held");
    expect(Date.now() - started).toBeLessThan(9_000);
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("gives up after the retry window", async () => {
    await take();
    const started = Date.now();
    await expect(acquireServerLock(database.connectionString, { ...fast, retryMs: 500, retryIntervalMs: 100 })).rejects.toBeInstanceOf(ServerLockHeldError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("shows up by name, so ops can see and clear it", async () => {
    await take();
    const rows = await admin`
      select a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and l.objsubid = 1`;
    expect(rows.map((row) => row.application_name)).toEqual([SERVER_LOCK_APPLICATION_NAME]);
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("takes the lock again when its connection is killed, and blocks a stray server again", async () => {
    const first = await take();
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${SERVER_LOCK_APPLICATION_NAME}`;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await first.check()).toBe("held");
    await expect(acquireServerLock(database.connectionString, fast)).rejects.toBeInstanceOf(ServerLockHeldError);
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("reports another holder after its connection drops, and keeps running", async () => {
    const errors: string[] = [];
    const first = await take({ log: { info: () => {}, error: (message: string) => errors.push(message) }, alertAfterMs: 0 });
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${SERVER_LOCK_APPLICATION_NAME}`;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stray = await acquireServerLock(database.connectionString, fast);
    expect(await first.check()).toBe("lost");
    expect(errors.join(" ")).toContain("another connection holds it");
    await stray.release();
    expect(await first.check()).toBe("held");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("doesn't stack the lock on repeat checks, so releasing really frees it", async () => {
    const first = await take();
    for (let i = 0; i < 3; i += 1) await first.check();
    await first.release();
    const second = await take();
    expect(second.state()).toBe("held");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("is freed when a process dies without cleaning up", async () => {
    const script = fileURLToPath(new URL("./server-lock.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { acquireServerLock } from ${JSON.stringify(script)};
      await acquireServerLock(process.env.TEST_URL, { retryMs: 0 });
      console.log("locked");
      setInterval(() => {}, 1000);
    `], {
      // `--import tsx` resolves from the working directory. CI runs vitest from the repo root, which has no tsx.
      cwd: dirname(script),
      env: { ...process.env, TEST_URL: database.connectionString },
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { if (String(chunk).includes("locked")) resolve(); });
      child.on("exit", () => reject(new Error("child exited early")));
    });
    await expect(acquireServerLock(database.connectionString, fast)).rejects.toBeInstanceOf(ServerLockHeldError);
    child.removeAllListeners("exit");
    child.kill("SIGKILL");
    const second = await take({ retryMs: 10_000, retryIntervalMs: 100 });
    expect(second.state()).toBe("held");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("carries on when the database can't be reached: a guard must not cause an outage", async () => {
    const errors: string[] = [];
    const handle = await acquireServerLock("postgres://nobody:nothing@127.0.0.1:1/none", {
      ...fast,
      log: { info: () => {}, error: (message) => errors.push(message) },
    });
    expect(handle.state()).toBe("not-held");
    expect(errors.join(" ")).toContain("carrying on");
    await handle.release();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("can be switched off", async () => {
    await take();
    const handle = await acquireServerLock(database.connectionString, { ...fast, env: { PAPERCLIP_ALLOW_SHARED_DATABASE: "true" } });
    expect(handle.state()).toBe("skipped");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("does not run a script's work while a server holds the lock", async () => {
    await take();
    let ran = false;
    await expect(withServerLockForScript(database.connectionString, async () => { ran = true; }, { log: quiet })).rejects.toBeInstanceOf(ServerLockHeldError);
    expect(ran).toBe(false);
    await releaseAll();
    await withServerLockForScript(database.connectionString, async () => { ran = true; }, { log: quiet });
    expect(ran).toBe(true);
    expect((await take()).state()).toBe("held");
    await releaseAll();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("keeps databases apart: a lock on one doesn't block another", async () => {
    await take();
    await admin`create database other_server_lock`;
    const other = await acquireServerLock(database.connectionString.replace(/\/[^/?]+(\?|$)/, "/other_server_lock$1"), fast);
    expect(other.state()).toBe("held");
    await other.release();
    await releaseAll();
    await admin`drop database other_server_lock`;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
