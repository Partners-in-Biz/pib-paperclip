import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PipelineStepCtx, PipelineSteps } from "./pipeline.js";
import { readR2Config } from "./settings.js";
import { r2Head, r2Put, recordingKey, type R2Config } from "./r2-store.js";
import { sha256Hex } from "./sigv4.js";

/**
 * Create media pipeline steps for Twilio recording storage.
 * Handles downloading from Twilio, storing in R2, and cleaning up from Twilio.
 */
export function createMediaSteps(deps?: {
  fetch?: typeof fetch;
  now?: () => Date;
  r2Config?: (ctx: PluginContext, companyId: string) => Promise<R2Config | null>;
}): PipelineSteps {
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const readR2ConfigFn = deps?.r2Config ?? readR2Config;

  /**
   * Resolve Twilio API Key SID and Secret, return Basic auth header.
   * Throws with secret name only (no value leaks).
   */
  async function twilioAuth(ctx: PluginContext, companyId: string): Promise<string> {
    let apiKey: string;
    try {
      apiKey = await ctx.secrets.resolve("TWILIO_API_KEY_SID", { companyId });
    } catch {
      throw new Error("Missing secret: TWILIO_API_KEY_SID");
    }

    let apiSecret: string;
    try {
      apiSecret = await ctx.secrets.resolve("TWILIO_API_KEY_SECRET", { companyId });
    } catch {
      throw new Error("Missing secret: TWILIO_API_KEY_SECRET");
    }

    return "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  }

  /**
   * received: Download recording from Twilio, store in R2, move to 'downloaded'.
   * Requires: row.company_id, row.twilio_url
   * On success: patch with r2Key, bytes, sha256
   * On error (404/410): state='dead' with error message (recording lost)
   */
  const received = async (sc: PipelineStepCtx): Promise<{ state: string; error?: string; patch?: { r2Key: string; bytes: number; sha256: string } }> => {
    if (!sc.row.company_id) {
      throw new Error("recording has no company_id");
    }

    const r2cfg = await readR2ConfigFn(sc.ctx, sc.row.company_id);
    if (!r2cfg) {
      throw new Error("R2 not configured for company");
    }

    // Build download URL: append .wav if no extension
    let url = sc.row.twilio_url;
    if (!/\.(wav|mp3)$/i.test(url)) {
      url = url + ".wav";
    }

    const authHeader = await twilioAuth(sc.ctx, sc.row.company_id);

    const leaseOk = await sc.extendLease();
    if (!leaseOk) {
      throw new Error("lease lost");
    }

    const response = await fetchFn(url, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 404 || response.status === 410) {
      return {
        state: "dead",
        error: "Twilio recording no longer exists (404) and no copy was stored in R2; recording lost",
      };
    }

    if (!response.ok) {
      throw new Error(`Twilio download failed: HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha = sha256Hex(bytes);
    const key = recordingKey(r2cfg, sc.row.call_sid, sc.row.recording_sid);

    await r2Put(r2cfg, key, bytes, sha, fetchFn);

    return {
      state: "downloaded",
      patch: {
        r2Key: key,
        bytes: bytes.length,
        sha256: sha,
      },
    };
  };

  /**
   * downloaded: Verify R2 copy and delete from Twilio.
   * Requires: row.r2_key, row.bytes, row.sha256
   * On success: state='twilio_deleted'
   * On mismatch or missing R2 object: throw (do not delete Twilio)
   */
  const downloaded = async (sc: PipelineStepCtx): Promise<{ state: string }> => {
    if (!sc.row.r2_key || sc.row.bytes === null || !sc.row.sha256) {
      throw new Error("recording missing r2_key, bytes, or sha256");
    }

    if (!sc.row.company_id) {
      throw new Error("recording has no company_id");
    }

    const r2cfg = await readR2ConfigFn(sc.ctx, sc.row.company_id);
    if (!r2cfg) {
      throw new Error("R2 not configured for company");
    }

    // Verify R2 object
    const head = await r2Head(r2cfg, sc.row.r2_key, fetchFn);
    if (!head) {
      throw new Error(`R2 object missing: ${sc.row.r2_key}`);
    }

    if (head.bytes !== Number(sc.row.bytes)) {
      throw new Error(`R2 size mismatch: expected ${sc.row.bytes}, got ${head.bytes}`);
    }

    // SECURITY: require both size and sha256 to match
    if (head.sha256 !== sc.row.sha256) {
      const headSha = head.sha256 ? `${head.sha256.slice(0, 16)}...` : "missing";
      throw new Error(`R2 hash mismatch: expected ${sc.row.sha256.slice(0, 16)}..., got ${headSha}`);
    }

    const leaseOk = await sc.extendLease();
    if (!leaseOk) {
      throw new Error("lease lost");
    }

    // Extract AccountSid from twilio_url
    const accountMatch = sc.row.twilio_url.match(/\/Accounts\/(AC[0-9a-f]+)\//i);
    if (!accountMatch) {
      throw new Error("Could not parse AccountSid from Twilio URL");
    }
    const accountSid = accountMatch[1];

    const authHeader = await twilioAuth(sc.ctx, sc.row.company_id);

    // Delete from Twilio
    const deleteUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sc.row.recording_sid}.json`;

    const deleteResponse = await fetchFn(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    // 204 (success) or 404 (already deleted, safe) are both OK
    if (deleteResponse.status !== 204 && deleteResponse.status !== 404) {
      throw new Error(`Twilio delete failed: HTTP ${deleteResponse.status}`);
    }

    return { state: "twilio_deleted" };
  };

  return { received, downloaded };
}
