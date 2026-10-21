import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { createBroker, BrokerError, DriveNotBoundError } from "../src/drive/broker.js";
import { createFakeBroker } from "./support/fake-broker.js";

describe("Broker uploadFile", () => {
  it("(a) ~4 MB random bytes round-trip with equal sha256 between sent and stored", async () => {
    const { uploadFetch, state } = createFakeBroker({ token: "test-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    // Generate ~4 MB of random data
    const bytes = randomBytes(4 * 1024 * 1024);
    const sentSha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await broker.uploadFile({
      name: "test-file.bin",
      bytes,
      mimeType: "application/octet-stream",
    });

    expect(result.sha256).toBe(sentSha256);
    expect(result.fileId).toBeDefined();
    expect(result.webViewLink).toContain("drive.google.com");
    expect(result.deduplicated).toBe(false);

    // Verify stored file has same sha256
    const stored = Array.from(state.files.values())[0];
    expect(stored.sha256).toBe(sentSha256);
  });

  it("(b) duplicate upload returns deduplicated:true and state.files length stays 1", async () => {
    const { uploadFetch, state } = createFakeBroker({ token: "test-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    const bytes = randomBytes(1024 * 1024); // 1 MB
    const result1 = await broker.uploadFile({
      name: "file.bin",
      bytes,
      mimeType: "application/octet-stream",
    });

    expect(result1.deduplicated).toBe(false);
    expect(state.files.size).toBe(1);

    const result2 = await broker.uploadFile({
      name: "file.bin",
      bytes,
      mimeType: "application/octet-stream",
    });

    expect(result2.deduplicated).toBe(true);
    expect(result2.fileId).toBe(result1.fileId);
    expect(state.files.size).toBe(1);
  });

  it("(c) 401 on wrong token -> BrokerError non-retryable", async () => {
    const { uploadFetch } = createFakeBroker({ token: "correct-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "wrong-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    const bytes = randomBytes(1024);
    let error: BrokerError | undefined;
    try {
      await broker.uploadFile({ name: "file.bin", bytes, mimeType: "application/octet-stream" });
    } catch (err) {
      error = err as BrokerError;
    }

    expect(error).toBeInstanceOf(BrokerError);
    expect(error?.status).toBe(401);
    expect(error?.retryable).toBe(false);
  });

  it("(d) 5xx -> retryable BrokerError", async () => {
    const { uploadFetch } = createFakeBroker({ failWith: 500, token: "test-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    const bytes = randomBytes(1024);
    let error: BrokerError | undefined;
    try {
      await broker.uploadFile({ name: "file.bin", bytes, mimeType: "application/octet-stream" });
    } catch (err) {
      error = err as BrokerError;
    }

    expect(error).toBeInstanceOf(BrokerError);
    expect(error?.status).toBe(500);
    expect(error?.retryable).toBe(true);
  });

  it("(e) oversize (5 MiB + 1) -> code too_large and state.requests is 0, exactly 5 MiB succeeds", async () => {
    const { uploadFetch, state } = createFakeBroker({ token: "test-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    // Test oversized file (no HTTP call should happen)
    const oversize = randomBytes(5 * 1024 * 1024 + 1);
    let error: BrokerError | undefined;
    try {
      await broker.uploadFile({ name: "huge.bin", bytes: oversize, mimeType: "application/octet-stream" });
    } catch (err) {
      error = err as BrokerError;
    }

    expect(error).toBeInstanceOf(BrokerError);
    expect(error?.code).toBe("too_large");
    expect(error?.status).toBe(413);
    expect(error?.retryable).toBe(false);
    expect(state.requests.length).toBe(0); // No HTTP request made

    // Test exactly 5 MiB (should succeed)
    const exact = randomBytes(5 * 1024 * 1024);
    const result = await broker.uploadFile({
      name: "exact.bin",
      bytes: exact,
      mimeType: "application/octet-stream",
    });
    expect(result.fileId).toBeDefined();
    expect(state.requests.length).toBe(1); // One request was made
  });

  it("(f) token string never appears in String(err)/err.message/JSON.stringify across failure cases", async () => {
    const { uploadFetch } = createFakeBroker({ token: "my-secret-token" });
    const broker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "my-secret-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    // Test 401
    const wrongBroker = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "my-secret-token", sharedDriveId: "drive1" },
      createFakeBroker({ token: "different-token" }).uploadFetch
    );

    let error: any;
    try {
      await wrongBroker.uploadFile({ name: "f.bin", bytes: randomBytes(100), mimeType: "application/octet-stream" });
    } catch (err) {
      error = err;
    }

    expect(String(error)).not.toContain("my-secret-token");
    expect(error.message).not.toContain("my-secret-token");
    expect(JSON.stringify(error)).not.toContain("my-secret-token");

    // Test oversize
    let oversizeError: any;
    try {
      await broker.uploadFile({ name: "huge.bin", bytes: randomBytes(5 * 1024 * 1024 + 1), mimeType: "application/octet-stream" });
    } catch (err) {
      oversizeError = err;
    }

    expect(String(oversizeError)).not.toContain("my-secret-token");
    expect(oversizeError.message).not.toContain("my-secret-token");
    expect(JSON.stringify(oversizeError)).not.toContain("my-secret-token");
  });

  it("(g) empty sharedDriveId -> drive_not_bound and zero requests", async () => {
    const { uploadFetch, state } = createFakeBroker({ token: "test-token" });

    // Test with empty sharedDriveId
    expect(() => {
      createBroker(
        async () => ({ status: 404, ok: false, text: async () => "{}" }),
        { baseUrl: "http://fake", token: "test-token", sharedDriveId: "" },
        uploadFetch
      );
    }).toThrow(DriveNotBoundError);

    // Also test with whitespace-only sharedDriveId
    expect(() => {
      createBroker(
        async () => ({ status: 404, ok: false, text: async () => "{}" }),
        { baseUrl: "http://fake", token: "test-token", sharedDriveId: "  " },
        uploadFetch
      );
    }).toThrow(DriveNotBoundError);

    // Verify no requests were made before error
    expect(state.requests.length).toBe(0);
  });

  it("(h) two different sharedDriveIds do not dedupe against each other", async () => {
    const { uploadFetch, state } = createFakeBroker({ token: "test-token" });
    const broker1 = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive1" },
      uploadFetch
    );

    const broker2 = createBroker(
      async () => ({ status: 404, ok: false, text: async () => "{}" }),
      { baseUrl: "http://fake", token: "test-token", sharedDriveId: "drive2" },
      uploadFetch
    );

    const bytes = randomBytes(1024);
    const result1 = await broker1.uploadFile({
      name: "file.bin",
      bytes,
      mimeType: "application/octet-stream",
    });

    const result2 = await broker2.uploadFile({
      name: "file.bin",
      bytes,
      mimeType: "application/octet-stream",
    });

    expect(result1.fileId).not.toBe(result2.fileId);
    expect(state.files.size).toBe(2);
  });
});
