/**
 * Read a local file through an open handle (PAR-9219 B.7): the sha256 in one pass with a 1 MiB buffer, then the bytes in
 * chunks for the Drive resumable upload. Reads go by offset on the handle, so a file unlinked after open (the host's
 * scratch cleanup at run end) still reads in full.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { CHUNK_BYTES } from "./r2-stream.js";

const HASH_BUFFER_BYTES = 1024 * 1024;

export class FileStreamError extends Error {
  constructor(message: string, readonly code: "size_mismatch") {
    super(message);
    this.name = "FileStreamError";
  }
}

const shortRead = () => new FileStreamError("The file got shorter while it was being read.", "size_mismatch");

/** Fills `buf[0..length)` from `position`; throws when the file ends first. */
async function readFully(fh: FileHandle, buf: Uint8Array, length: number, position: number): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw shortRead();
    done += bytesRead;
  }
}

/** The hex sha256 of the first `size` bytes. */
export async function hashFile(fh: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buf = new Uint8Array(Math.min(HASH_BUFFER_BYTES, Math.max(size, 1)));
  for (let position = 0; position < size; ) {
    const length = Math.min(buf.length, size - position);
    await readFully(fh, buf, length, position);
    hash.update(buf.subarray(0, length));
    position += length;
  }
  return hash.digest("hex");
}

/** The first `size` bytes in chunks of `chunkBytes` (the last one shorter). Each chunk is a fresh buffer. */
export async function* fileChunks(fh: FileHandle, size: number, chunkBytes: number = CHUNK_BYTES): AsyncGenerator<Uint8Array> {
  for (let position = 0; position < size; ) {
    const length = Math.min(chunkBytes, size - position);
    const chunk = new Uint8Array(length);
    await readFully(fh, chunk, length, position);
    position += length;
    yield chunk;
  }
}

/** True when two `fstat`s show the same file content state: same inode, size and mtime. */
export function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
