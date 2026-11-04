import { describe, expect, it } from "vitest";
import { OWNER_COMPANY_PREFIX } from "@partnersinbiz/pib-plugin-kit";
import { loadBrowserView } from "../src/browser-status.js";
import type { Env } from "../src/env.js";

const NOW = new Date("2026-11-03T07:00:00.000Z");
const file = (checkedAt: string) => JSON.stringify({ checkedAt, identities: { "pib:meta": { ok: true }, "client:ca:google-ads": { ok: false, reason: "session_expired" } } });

function setup(prefix: string, text: string | null) {
  const reads: string[] = [];
  const env = {
    ctx: { companies: { get: async () => ({ issuePrefix: prefix }) } },
    now: () => NOW,
    readStatusFile: async (path: string) => { reads.push(path); return text; },
  } as unknown as Env;
  return { env, reads };
}
const run = (env: Env) => loadBrowserView(env, { companyId: "c1" } as never);

describe("loadBrowserView (owner-only)", () => {
  it("gives a non-owner company nothing and never reads the file", async () => {
    const { env, reads } = setup("ZZZ", file(NOW.toISOString()));
    const view = await run(env);
    expect(view).toMatchObject({ state: "unavailable", identities: [] });
    expect(reads).toEqual([]);
  });
  it("gives the owner company the parsed logins", async () => {
    const { env, reads } = setup(OWNER_COMPANY_PREFIX, file(NOW.toISOString()));
    const view = await run(env);
    expect(reads.length).toBe(1);
    expect(view.state).toBe("read");
    expect(view.stale).toBe(false);
    expect(view.identities.map((i) => [i.identity, i.ok])).toEqual([["pib:meta", true], ["client:ca:google-ads", false]]);
  });
  it("reports a missing file", async () => expect((await run(setup(OWNER_COMPANY_PREFIX, null).env)).state).toBe("missing"));
  it("reports a garbage file", async () => expect((await run(setup(OWNER_COMPANY_PREFIX, "not json").env)).state).toBe("invalid"));
  it("flags a stale file", async () => {
    const view = await run(setup(OWNER_COMPANY_PREFIX, file("2026-11-01T00:00:00.000Z")).env);
    expect(view.state).toBe("read");
    expect(view.stale).toBe(true);
  });
});
