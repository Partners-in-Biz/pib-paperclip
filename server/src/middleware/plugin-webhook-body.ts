import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from "../errors.js";
import { DEFAULT_JSON_BODY_LIMIT } from "../http/body-limits.js";

// 10 MB default JSON body limit converted to bytes
const DEFAULT_JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

const rawBodyParser = express.raw({
  inflate: false,
  limit: DEFAULT_JSON_BODY_LIMIT,
  type: () => true, // Accept all types initially; we filter in the middleware
});

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function bodyTooLarge() {
  return payloadTooLarge("Plugin webhook request body is too large", {
    code: "plugin_webhook_body_too_large",
    maxBytes: DEFAULT_JSON_BODY_LIMIT_BYTES,
  });
}

function parseContentLength(req: Request): bigint | null {
  const value = req.headers["content-length"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/.test(value)) {
    throw badRequest("Invalid Content-Length header", {
      code: "plugin_webhook_content_length_invalid",
    });
  }
  return BigInt(value);
}

/**
 * Capture raw webhook bytes for non-JSON content types.
 * JSON requests are passed through to the global express.json parser.
 * For non-JSON requests, we read the raw bytes and preserve them in req.rawBody
 * while keeping req.body undefined (Express 5) so the global JSON parser skips.
 */
export const pluginWebhookBodyParser: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Pass through JSON requests to the global express.json parser
  if (req.is("json")) {
    next();
    return;
  }

  let contentLength: bigint | null;
  try {
    contentLength = parseContentLength(req);
  } catch (error) {
    req.resume();
    next(error);
    return;
  }

  if (
    contentLength !== null &&
    contentLength > BigInt(DEFAULT_JSON_BODY_LIMIT_BYTES)
  ) {
    next(bodyTooLarge());
    return;
  }

  rawBodyParser(req, res, (error?: unknown) => {
    if (!error) {
      // Successfully read the raw buffer. Store it in req.rawBody.
      const body = req.body;
      if (body instanceof Buffer) {
        (req as unknown as Record<string, Buffer>).rawBody = body;
      } else {
        // If body is not a Buffer, set rawBody to empty Buffer
        (req as unknown as Record<string, Buffer>).rawBody = Buffer.alloc(0);
      }
      // Set req._body to true so the global express.json parser will skip processing.
      // For Express 5, body-parser automatically sets this when it reads the stream.
      // Reset req.body to undefined (Express 5 default for unparsed bodies).
      (req as unknown as Record<string, unknown>).body = undefined;
      next();
      return;
    }

    const parserError = error as BodyParserError;
    if (parserError.status === 413 || parserError.type === "entity.too.large") {
      next(bodyTooLarge());
      return;
    }
    if (parserError.type === "encoding.unsupported") {
      next(
        unsupportedMediaType("Encoded plugin webhook bodies are not supported", {
          code: "plugin_webhook_content_encoding_unsupported",
        }),
      );
      return;
    }
    next(error);
  });
};
