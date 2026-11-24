import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";

/** A ctx that records every host call and answers the known-company state and the actionable list. */
function recordingCtx(known: string[], actionable: string[]) {
  const calls: string[] = [];
  const answer = (path: string, args: unknown[]): unknown => {
    path = path.replace(/\.call$/, "");
    const input = (path === "ctx.companies.list" && args.length > 1 ? args[1] : args[0]) as { actionableOnly?: boolean; stateKey?: string } | undefined;
    if (path === "ctx.companies.list") return (input?.actionableOnly ? actionable : known).map((id) => ({ id }));
    if (path === "ctx.db.query") return known.map((id) => ({ company_id: id }));
    if (path.endsWith("Symbol(Symbol.toPrimitive)")) return "plugin_test";
    if (path === "ctx.state.get" && /compan/.test(input?.stateKey ?? "")) return known;
    return null;
  };
  const make = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "then" ? undefined : make(`${path}.${String(prop)}`)),
      apply: (_t, _this, args) => {
        calls.push(`${path} ${JSON.stringify(args)}`);
        const out = answer(path, args);
        return path.endsWith("Symbol(Symbol.toPrimitive)") ? out : Promise.resolve(out);
      },
    });
  return { ctx: make("ctx") as PluginContext, calls };
}

import { publishCockpitSnapshots } from "../src/cockpit.js";

const ON = "company-configured";
const OFF = "company-unconfigured";

describe("social cockpit job (PAR-14008)", () => {
  it("makes no host call for a company with no saved settings", async () => {
    const { ctx, calls } = recordingCtx([ON, OFF], [ON]);
    await publishCockpitSnapshots(ctx);
    expect(calls.some((c) => c.includes(ON))).toBe(true);
    expect(calls.filter((c) => c.includes(OFF))).toEqual([]);
  });
});

describe("social token refresh and inbox jobs (PAR-14008)", () => {
  it("make no host call for a company with no saved settings", async () => {
    const { refreshTokensJob } = await import("../src/tokens.js");
    const { pollInboxJob } = await import("../src/inbox.js");
    for (const run of [refreshTokensJob, pollInboxJob]) {
      const { ctx, calls } = recordingCtx([ON, OFF], [ON]);
      await run(ctx, async () => undefined).catch(() => undefined);
      expect(calls.some((c) => c.includes(ON))).toBe(true);
      expect(calls.filter((c) => c.includes(OFF) && !c.startsWith("ctx.db."))).toEqual([]);
    }
  });
});
