/**
 * The VPS deploy gate runs the specs as root with CI=1. Postgres refuses to start as root, so the database
 * specs must skip there instead of throwing; a throw refused every Setup deploy (PAR-13055).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedAvailable } from "./helpers/pg.js";

describe("embeddedAvailable in the deploy gate", () => {
  const ci = process.env.CI;
  afterEach(() => {
    vi.restoreAllMocks();
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
  });

  it("skips (false) as root under CI instead of throwing", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    process.env.CI = "1";
    await expect(embeddedAvailable()).resolves.toBe(false);
  });
});
