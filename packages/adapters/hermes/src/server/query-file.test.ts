import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KERNEL_STRING_LIMIT, guardEnvStrings, prepareQuery, sweepOldQueries } from "./query-file.js";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "par6886-qf-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("prepareQuery", () => {
  it("writes the whole prompt to a private 0600 file and passes --query-file", async () => {
    const prompt = "é".repeat(100000); // 200000 bytes, over the kernel limit for argv
    const query = await prepareQuery(prompt, root);
    expect(query.via).toBe("--query-file");
    expect(query.bytes).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(query.bytes).toBeGreaterThan(KERNEL_STRING_LIMIT);
    expect(query.args[0]).toBe("--query-file");
    expect(query.args).not.toContain(prompt);
    const file = query.args[1];
    expect(path.dirname(path.dirname(file))).toBe(root);
    expect(await fsp.readFile(file, "utf8")).toBe(prompt);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes the folder on cleanup and cleanup can run twice", async () => {
    const query = await prepareQuery("hello", root);
    const dir = path.dirname(query.args[1]);
    await query.cleanup();
    await expect(fsp.stat(dir)).rejects.toThrow();
    await expect(query.cleanup()).resolves.toBeUndefined();
  });

  it("falls back to -q for a small prompt when the file cannot be written", async () => {
    const query = await prepareQuery("small prompt", path.join(root, "missing", "deeper"));
    expect(query.via).toBe("-q");
    expect(query.args).toEqual(["-q", "small prompt"]);
    await expect(query.cleanup()).resolves.toBeUndefined();
  });

  it("throws instead of falling back to argv for a prompt the kernel would refuse", async () => {
    const prompt = "x".repeat(KERNEL_STRING_LIMIT);
    await expect(prepareQuery(prompt, path.join(root, "missing", "deeper"))).rejects.toThrow(
      /too large for one command-line argument/,
    );
  });
});

describe("sweepOldQueries", () => {
  it("removes only our own query folders that are older than a day", async () => {
    const old = path.join(root, "paperclip-hermes-query-abc123");
    const fresh = path.join(root, "paperclip-hermes-query-def456");
    const other = path.join(root, "unrelated-folder");
    for (const dir of [old, fresh, other]) await fsp.mkdir(dir);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsp.utimes(old, twoDaysAgo, twoDaysAgo);
    await fsp.utimes(other, twoDaysAgo, twoDaysAgo);

    await sweepOldQueries(true, root);

    await expect(fsp.stat(old)).rejects.toThrow();
    await expect(fsp.stat(fresh)).resolves.toBeTruthy();
    await expect(fsp.stat(other)).resolves.toBeTruthy();
  });
});

describe("guardEnvStrings", () => {
  it("drops only strings the kernel would refuse and reports them", () => {
    const env: Record<string, string | undefined> = {
      SMALL: "ok",
      JUST_UNDER: "a".repeat(KERNEL_STRING_LIMIT - "JUST_UNDER".length - 2),
      TOO_BIG: "a".repeat(KERNEL_STRING_LIMIT),
      UNSET: undefined,
    };
    const dropped = guardEnvStrings(env);
    expect(dropped).toEqual([{ key: "TOO_BIG", bytes: "TOO_BIG".length + 1 + KERNEL_STRING_LIMIT + 1 }]);
    expect(env.TOO_BIG).toBeUndefined();
    expect(env.SMALL).toBe("ok");
    expect(env.JUST_UNDER).toBeDefined();
  });
});
