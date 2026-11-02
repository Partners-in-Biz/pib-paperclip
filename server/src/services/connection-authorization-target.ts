import { createHash } from "node:crypto";
import { requestConfirmationPayloadSchema } from "@paperclipai/shared";

// Mirrors requestConfirmationCustomTargetSchema.key (max 120). The connection
// authorization builders write issue_thread_interactions rows directly, so the
// cap is enforced here instead of by the create path.
const CUSTOM_TARGET_KEY_MAX_LENGTH = 120;

/**
 * Stable target key for a "connect your account" confirmation. Gallery
 * connection uids can be long (`app-gallery:google-drive:<uuid>/google-drive-<id>`),
 * which pushed the key to 132 chars and made the stored row unparseable. Over the
 * cap, fall back to a sha256 of the same inputs: same connection + user always
 * yields the same key.
 */
export function connectionAuthorizationTargetKey(
  connectionUid: string,
  userId: string,
): string {
  const key = `connection:${connectionUid}:user:${userId}`;
  if (key.length <= CUSTOM_TARGET_KEY_MAX_LENGTH) return key;
  const digest = createHash("sha256").update(key).digest("hex");
  return `connection-sha256:${digest}`;
}

/**
 * Validate a connection-authorization payload before it is persisted, so a row
 * that the read path cannot hydrate is never written.
 */
export function assertValidConnectionAuthorizationPayload<
  T extends Record<string, unknown>,
>(payload: T): T {
  requestConfirmationPayloadSchema.parse(payload);
  return payload;
}
