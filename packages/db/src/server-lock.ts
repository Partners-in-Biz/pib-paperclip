import postgres from "postgres";

/**
 * One Paperclip server per database.
 *
 * A server started from an agent run can pick up the live config and connect to
 * the live database, and its startup then rewrites live rows with the branch's
 * code (PAR-7750). So a server holds a session-level advisory lock for its whole
 * life, taken before anything else touches the database, and a second server
 * refuses to start. The migrate and seed scripts refuse too.
 *
 * This guards against accidents, not against a process trying to get around it.
 * It must never take a running site down, so only "another server holds the
 * lock" is a refusal. Any other error logs and carries on.
 */

/** Advisory locks are per database, so servers on their own databases don't collide. */
export const SERVER_LOCK_KEY = 1346587728; // "PCLP"
/** Named in pg_stat_activity, so ops can see the holder and clear a stray one. */
export const SERVER_LOCK_APPLICATION_NAME = "paperclip-server-lock";
export const SERVER_LOCK_OPT_OUT_ENV = "PAPERCLIP_ALLOW_SHARED_DATABASE";

const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;
const DEFAULT_CHECK_INTERVAL_MS = 10_000;
const DEFAULT_ALERT_AFTER_MS = 120_000;

export interface ServerLockLogger {
  info(message: string): void;
  error(message: string): void;
}

const consoleLogger: ServerLockLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

export class ServerLockHeldError extends Error {
  readonly code = "SERVER_LOCK_HELD";

  constructor(holder: string | null) {
    super(
      `Another Paperclip server is using this database${holder ? ` (${holder})` : ""}, so this one will not start. ` +
        "If this is a test server, it has picked up the live config: run it with a clean environment " +
        "(env -i, with only your worktree's PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID and PAPERCLIP_CONFIG) " +
        "and check that the banner says embedded PostgreSQL.",
    );
    this.name = "ServerLockHeldError";
  }
}

export interface ServerLockOptions {
  retryMs?: number;
  retryIntervalMs?: number;
  checkIntervalMs?: number;
  alertAfterMs?: number;
  log?: ServerLockLogger;
  env?: NodeJS.ProcessEnv;
}

export type ServerLockState = "held" | "lost" | "not-held" | "released" | "skipped";

export interface ServerLockHandle {
  state(): ServerLockState;
  /** Run one check now. The timer does this on its own. */
  check(): Promise<ServerLockState>;
  release(): Promise<void>;
}

const skipped: ServerLockHandle = {
  state: () => "skipped",
  check: async () => "skipped",
  release: async () => {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openConnection(url: string) {
  // max_lifetime must stay off: the default recycles a connection after 30-60
  // minutes, and a closed connection silently gives up the lock.
  return postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: SERVER_LOCK_APPLICATION_NAME },
  });
}

type Sql = ReturnType<typeof openConnection>;

async function tryLock(sql: Sql): Promise<boolean> {
  const rows = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${SERVER_LOCK_KEY}::bigint) as locked`;
  return rows[0]?.locked === true;
}

async function holdsLock(sql: Sql): Promise<boolean> {
  const rows = await sql<{ held: boolean }[]>`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid() and granted
        and classid = 0 and objid = ${SERVER_LOCK_KEY} and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())
    ) as held`;
  return rows[0]?.held === true;
}

async function describeHolder(sql: Sql): Promise<string | null> {
  try {
    const rows = await sql<{ pid: number; backend_start: Date | null }[]>`
      select a.pid, a.backend_start from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted
        and l.classid = 0 and l.objid = ${SERVER_LOCK_KEY} and l.objsubid = 1
        and l.database = (select oid from pg_database where datname = current_database())
      limit 1`;
    const row = rows[0];
    return row ? `database backend ${row.pid}, connected ${new Date(row.backend_start ?? 0).toISOString()}` : null;
  } catch {
    return null;
  }
}

/**
 * Take the lock and keep it. Throws ServerLockHeldError only when another server
 * holds it after the retry window, which covers an old process still exiting.
 * Any other failure returns a "not-held" handle: the database being unreachable
 * is reported by whatever needs it next, and a guard must not cause an outage.
 */
export async function acquireServerLock(url: string, options: ServerLockOptions = {}): Promise<ServerLockHandle> {
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLogger;
  if (env[SERVER_LOCK_OPT_OUT_ENV] === "true") {
    log.info(`Single-server lock skipped: ${SERVER_LOCK_OPT_OUT_ENV} is set`);
    return skipped;
  }

  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const alertAfterMs = options.alertAfterMs ?? DEFAULT_ALERT_AFTER_MS;
  const sql = openConnection(url);

  let state: ServerLockState = "not-held";
  let unheldSince: number | null = Date.now();
  let alerted = false;
  let checking = false;
  let timer: NodeJS.Timeout | null = null;

  const markUnheld = (next: ServerLockState, reason: string) => {
    if (state === "held") log.error(`Single-server lock lost: ${reason}. Trying to take it again.`);
    state = next;
    unheldSince ??= Date.now();
    if (!alerted && Date.now() - unheldSince >= alertAfterMs) {
      alerted = true;
      log.error(`Single-server lock not held for ${Math.round(alertAfterMs / 1000)}s: ${reason}. This server keeps running.`);
    }
  };

  const markHeld = () => {
    if (state !== "held" && unheldSince !== null && alerted) log.info("Single-server lock is held again");
    state = "held";
    unheldSince = null;
    alerted = false;
  };

  const check = async (): Promise<ServerLockState> => {
    if (state === "released" || checking) return state;
    checking = true;
    try {
      if ((await holdsLock(sql)) || (await tryLock(sql))) markHeld();
      else markUnheld("lost", "another connection holds it");
    } catch (error) {
      markUnheld("lost", errorText(error));
    } finally {
      checking = false;
    }
    return state;
  };

  const release = async () => {
    state = "released";
    if (timer) clearInterval(timer);
    timer = null;
    await sql.end({ timeout: 2 }).catch(() => {});
  };

  const deadline = Date.now() + retryMs;
  for (;;) {
    let locked: boolean;
    try {
      locked = await tryLock(sql);
    } catch (error) {
      log.error(`Single-server lock could not be checked, carrying on: ${errorText(error)}`);
      break;
    }
    if (locked) {
      markHeld();
      break;
    }
    if (Date.now() >= deadline) {
      const holder = await describeHolder(sql);
      await sql.end({ timeout: 2 }).catch(() => {});
      throw new ServerLockHeldError(holder);
    }
    await sleep(Math.min(retryIntervalMs, Math.max(deadline - Date.now(), 0)));
  }

  timer = setInterval(() => void check(), checkIntervalMs);
  timer.unref?.();
  return { state: () => state, check, release };
}

/** For scripts that change the schema or data: refuse straight away while a server is using the database. */
export async function withServerLockForScript<T>(url: string, work: () => Promise<T>, options: ServerLockOptions = {}): Promise<T> {
  const handle = await acquireServerLock(url, { retryMs: 0, ...options });
  try {
    return await work();
  } finally {
    await handle.release();
  }
}
