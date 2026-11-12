import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { boot, CO, toolRaw, seed, company, contact } from "./helpers/crm.js";
import { clearServiceAccountTokenCache } from "../src/drive/google-sa.js";
import { DRIVE_KEY_TTL_MS } from "../src/drive/sa-secret.js";
import { DRIVE_ID, KEY_JSON, fakeGoogle } from "./support/fake-google-drive.js";

/**
 * PAR-9358: the host allows 30 secret lookups a minute per company for the whole CRM plugin. The Drive key is read
 * once and kept for five minutes, so a run of Drive calls costs one lookup.
 */
const REF = { type: "secret_ref", secretId: "sec-drive-sa" };

/** The host's limiter: 30 lookups in any 60 s, then "Rate limit exceeded for secret resolution". */
function limitedResolver(values: () => string) {
  const at: number[] = [];
  return vi.fn(async () => {
    const now = Date.now();
    while (at.length && now - at[0]! > 60_000) at.shift();
    if (at.length >= 30) throw new Error("Rate limit exceeded for secret resolution");
    at.push(now);
    return values();
  });
}

async function setup(google = fakeGoogle(), key: () => string = () => KEY_JSON) {
  const st = seed();
  st.companies!.push(company("co-a", "Acme Ltd"));
  st.contacts!.push(contact("contact-a", "Primary Contact"));
  st.contact_companies!.push({ id: "cc-a", company_id: CO, contact_id: "contact-a", account_id: "co-a", role_label: "primary", created_at: "2026-01-01T00:00:00Z" });
  st.client_projects!.push({ id: "cp-1", company_id: CO, project_id: "p-seo", client_kind: "company", client_ref: "co-a", kind: "seo", created_at: "2026-01-01T00:00:00Z" });
  const { harness } = await boot({ config: { driveServiceAccountJson: REF, drive: { sharedDriveId: DRIVE_ID } }, store: st });
  harness.seed({ projects: [{ id: "p-seo", companyId: CO, name: "Acme SEO" } as never] });
  const resolve = limitedResolver(key);
  harness.ctx.secrets.resolve = resolve as never;
  vi.stubGlobal("fetch", google.fetchFn);
  return { harness, google, resolve };
}

beforeEach(() => clearServiceAccountTokenCache());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Drive service account key cache (PAR-9358)", () => {
  it("100 drive_folder_resolve calls in a row resolve the secret once and never hit the rate limit", async () => {
    const { harness, google, resolve } = await setup();
    for (let i = 0; i < 100; i++) {
      const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
      expect(r.error).toBeUndefined();
      expect(r.data?.status).toBe("not_found");
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    // Read-only: nothing was created in Drive.
    expect(google.files).toHaveLength(0);
  });

  it("re-reads the secret after the five-minute TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, resolve } = await setup();
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(resolve).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + DRIVE_KEY_TTL_MS + 1);
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("when Google refuses the cached key, reads the secret once more and retries with the rotated key", async () => {
    const google = fakeGoogle();
    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      // The first token request (the old key) is refused; the rotated key is accepted.
      if (new URL(url).hostname === "oauth2.googleapis.com" && tokenCalls++ === 0) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), { status: 400 });
      }
      return google.fetchFn(url, init as never);
    });
    const rotated = JSON.stringify({ ...JSON.parse(KEY_JSON), private_key_id: "kid2" });
    let reads = 0;
    const { harness, resolve } = await setup({ ...google, fetchFn } as never, () => (reads++ === 0 ? KEY_JSON : rotated));
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(r.data?.status).toBe("not_found");
    expect(resolve).toHaveBeenCalledTimes(2);
    // The rotated key is now cached.
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("a key Google keeps refusing costs one extra lookup, not one per call", async () => {
    const { harness, resolve } = await setup(fakeGoogle({ tokenStatus: 400 }));
    for (let i = 0; i < 20; i++) {
      const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
      expect(JSON.stringify(r)).not.toMatch(/Rate limit exceeded/);
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY/);
    }
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("a failed lookup is not cached", async () => {
    const { harness, resolve } = await setup();
    resolve.mockRejectedValueOnce(new Error("Rate limit exceeded for secret resolution"));
    await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    const r = await toolRaw(harness, "drive_folder_resolve", { entity_type: "project", entity_id: "p-seo" });
    expect(r.data?.status).toBe("not_found");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
