/** Local-file chunk source (PAR-9219 B.7): hash and chunks by offset on an open handle, generated data only. */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileChunks, FileStreamError, hashFile, sameFile } from "../src/drive/file-stream.js";
import { CHUNK_BYTES } from "../src/drive/r2-stream.js";

describe("file-stream", () => {
  let dir: string;
  let big: string;
  let bigSha: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "drive-file-stream-"));
    big = join(dir, "big.bin");
    const block = randomBytes(1024 * 1024);
    const hash = createHash("sha256");
    writeFileSync(big, "");
    for (let i = 0; i < 64; i++) {
      block[0] = i; // every MiB differs, so a reordered chunk changes the hash
      appendFileSync(big, block);
      hash.update(block);
    }
    bigSha = hash.digest("hex");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("64 MiB: 8 chunks of exactly 8 MiB, and hashFile equals crypto over the whole file", async () => {
    const fh = await open(big, "r");
    try {
      const size = (await fh.stat()).size;
      expect(size).toBe(64 * 1024 * 1024);
      expect(await hashFile(fh, size)).toBe(bigSha);
      const sizes: number[] = [];
      const hash = createHash("sha256");
      for await (const chunk of fileChunks(fh, size)) {
        sizes.push(chunk.length);
        hash.update(chunk);
      }
      expect(sizes).toEqual(Array(8).fill(CHUNK_BYTES));
      expect(hash.digest("hex")).toBe(bigSha);
    } finally {
      await fh.close();
    }
  }, 60_000);

  it("the last chunk is shorter; a 0-byte file hashes and yields nothing", async () => {
    const p = join(dir, "odd.bin");
    writeFileSync(p, Buffer.alloc(10, 7));
    const fh = await open(p, "r");
    const sizes: number[] = [];
    for await (const chunk of fileChunks(fh, 10, 4)) sizes.push(chunk.length);
    expect(sizes).toEqual([4, 4, 2]);
    const empty = join(dir, "empty.bin");
    writeFileSync(empty, "");
    const eh = await open(empty, "r");
    expect(await hashFile(eh, 0)).toBe(createHash("sha256").digest("hex"));
    const none: Uint8Array[] = [];
    for await (const chunk of fileChunks(eh, 0)) none.push(chunk);
    expect(none).toEqual([]);
    await fh.close();
    await eh.close();
  });

  it("unlinking the file after open still streams all bytes", async () => {
    const p = join(dir, "gone.bin");
    const data = randomBytes(3 * 1024 * 1024 + 5);
    writeFileSync(p, data);
    const fh = await open(p, "r");
    unlinkSync(p);
    const parts: Uint8Array[] = [];
    for await (const chunk of fileChunks(fh, data.length, 1024 * 1024)) parts.push(chunk);
    expect(Buffer.concat(parts).equals(data)).toBe(true);
    expect(await hashFile(fh, data.length)).toBe(createHash("sha256").update(data).digest("hex"));
    await fh.close();
  });

  it("a file shorter than the expected size is a size_mismatch, not a short upload", async () => {
    const p = join(dir, "short.bin");
    writeFileSync(p, Buffer.alloc(100));
    const fh = await open(p, "r");
    await expect(hashFile(fh, 200)).rejects.toBeInstanceOf(FileStreamError);
    const read = async () => { for await (const _ of fileChunks(fh, 200, 64)) void _; };
    await expect(read()).rejects.toMatchObject({ code: "size_mismatch" });
    await fh.close();
  });

  it("sameFile detects a size change and an mtime change", () => {
    const p = join(dir, "same.bin");
    writeFileSync(p, "abc");
    const a = statSync(p);
    expect(sameFile(a, statSync(p))).toBe(true);
    appendFileSync(p, "d");
    const grown = statSync(p);
    expect(sameFile(a, grown)).toBe(false);
    utimesSync(p, grown.atime, new Date(grown.mtimeMs - 60_000));
    const touched = statSync(p);
    expect(touched.size).toBe(grown.size);
    expect(sameFile(grown, touched)).toBe(false);
  });
});
