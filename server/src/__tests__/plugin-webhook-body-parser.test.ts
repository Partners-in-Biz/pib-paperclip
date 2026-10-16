import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEFAULT_JSON_BODY_LIMIT_BYTES } from "../http/body-limits.js";
import { pluginWebhookBodyParser } from "../middleware/plugin-webhook-body.js";
import { errorHandler } from "../middleware/index.js";

/**
 * Test app that mirrors the mounting order in app.ts:
 * 1. pluginWebhookBodyParser (for non-JSON requests)
 * 2. express.json with captureRawBody
 * 3. A handler that echoes back what it received
 */
function createTestApp() {
  const app = express();

  const captureRawBody = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer,
  ) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  app.use(pluginWebhookBodyParser);
  app.use(
    express.json({
      limit: "10mb",
      verify: captureRawBody,
    }),
  );

  app.post("/webhook", (req: Request, res: Response) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const parsedBody = req.body;
    res.json({
      rawBody: rawBody ? rawBody.toString("utf-8") : null,
      parsedBody,
    });
  });

  app.use(errorHandler);

  return app;
}

describe("pluginWebhookBodyParser", () => {
  it("passes through JSON requests to the global express.json parser", async () => {
    const app = createTestApp();
    const body = { type: "test", data: { count: 42 } };

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.parsedBody).toEqual(body);
    expect(response.body.rawBody).toBeTruthy(); // The global express.json's verify callback captured it
  });

  it("captures raw bytes for text/plain with non-ASCII characters", async () => {
    const app = createTestApp();
    // Body with non-ASCII characters (UTF-8 encoded)
    const bodyText = 'Hello "world" with emoji: 🎉 and "quotes"';
    const bodyBuffer = Buffer.from(bodyText, "utf-8");

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "text/plain; charset=UTF-8")
      .send(bodyBuffer);

    expect(response.status).toBe(200);
    // The rawBody should be the exact bytes sent
    expect(response.body.rawBody).toBe(bodyText);
    // parsedBody should be undefined (not parsed as JSON)
    expect(response.body.parsedBody).toBeUndefined();
  });

  it("captures raw bytes for application/x-www-form-urlencoded", async () => {
    const app = createTestApp();
    const formBody = "field1=value1&field2=value2";

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(formBody);

    expect(response.status).toBe(200);
    expect(response.body.rawBody).toBe(formBody);
    expect(response.body.parsedBody).toBeUndefined();
  });

  it("captures raw bytes for application/octet-stream", async () => {
    const app = createTestApp();
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "application/octet-stream")
      .send(binaryData);

    expect(response.status).toBe(200);
    // The response will be the string representation of the buffer
    const expectedBody = binaryData.toString("utf-8");
    expect(response.body.rawBody).toBe(expectedBody);
    expect(response.body.parsedBody).toBeUndefined();
  });

  it("handles POST with no body", async () => {
    const app = createTestApp();

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "text/plain");

    expect(response.status).toBe(200);
    // Empty body should result in empty string
    expect(response.body.rawBody).toBe("");
    expect(response.body.parsedBody).toBeUndefined();
  });

  it("handles POST with no Content-Type header", async () => {
    const app = createTestApp();

    const response = await request(app)
      .post("/webhook")
      .send("some data");

    expect(response.status).toBe(200);
    // Without content-type, it should still capture the raw body
    expect(response.body.rawBody).toBe("some data");
    expect(response.body.parsedBody).toBeUndefined();
  });


  it("rejects invalid Content-Length header with 400", async () => {
    const app = createTestApp();

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "text/plain")
      .set("content-length", "not-a-number")
      .send("body");

    expect(response.status).toBe(400);
  });

  it("preserves JSON request with complex nested structure", async () => {
    const app = createTestApp();
    const complexBody = {
      users: [
        { id: 1, name: "Alice", tags: ["admin", "user"] },
        { id: 2, name: "Bob", metadata: { created: "2024-01-01", active: true } },
      ],
      nested: {
        deep: {
          structure: [1, 2, 3],
        },
      },
    };

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "application/json")
      .send(complexBody);

    expect(response.status).toBe(200);
    expect(response.body.parsedBody).toEqual(complexBody);
    // Raw body should preserve the JSON structure
    expect(response.body.rawBody).toBeTruthy();
  });

  it("handles JSON with leading/trailing whitespace", async () => {
    const app = createTestApp();
    // JSON with whitespace that would be different if re-serialized
    const jsonWithWhitespace = '  { "key" : "value" }  \n';

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "application/json")
      .send(jsonWithWhitespace);

    expect(response.status).toBe(200);
    // Parsed body should have the actual data
    expect(response.body.parsedBody).toEqual({ key: "value" });
    // Raw body should preserve whitespace
    expect(response.body.rawBody).toContain("  {");
  });

  it("handles text/plain with JSON-looking content", async () => {
    const app = createTestApp();
    // A string that looks like JSON but is marked as text/plain
    const jsonAsText = '{"type":"SNS","message":"Hello"}';

    const response = await request(app)
      .post("/webhook")
      .set("content-type", "text/plain")
      .send(jsonAsText);

    expect(response.status).toBe(200);
    // Should capture as raw text, not parse
    expect(response.body.rawBody).toBe(jsonAsText);
    expect(response.body.parsedBody).toBeUndefined();
  });
});
