/**
 * A world for tests that need both halves: the Cockpit's own database and the
 * host's tables on a REAL Postgres with the host SQL rules (helpers/pg.ts), and
 * the rest of the host (issues, agents, comments, grants, state, events) as the
 * in-memory fake (helpers/fake-ctx.ts). One Postgres per spec file; each test
 * makes a fresh fake and a clean database.
 */
import { createEnv, registerCockpit } from "../../src/register.js";
import { fakeCtx, fixedClock } from "./fake-ctx.js";
import { startPg, type PgHarness } from "./pg.js";

export type Hybrid = ReturnType<typeof world>;

export async function startWorlds(): Promise<{ pg: PgHarness; make: (options?: Parameters<typeof fakeCtx>[0], now?: string) => Promise<Hybrid>; stop: () => Promise<void> }> {
  const pg = await startPg();
  return {
    pg,
    async make(options = {}, now = "2026-10-03T12:00:00.000Z") {
      await pg.reset();
      return world(pg, options, now);
    },
    stop: () => pg.stop(),
  };
}

function world(pg: PgHarness, options: Parameters<typeof fakeCtx>[0], now: string) {
  const fake = fakeCtx(options);
  // The database is real; everything else is the fake host.
  (fake.ctx as unknown as { db: unknown }).db = pg.ctx.db;
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  env.sleep = async () => undefined;
  // The real wiring: events, jobs, tools, actions and the ask effects, as the worker registers them.
  registerCockpit(fake.ctx, env);
  return { ...fake, pg, client: pg.client, clock, env };
}
