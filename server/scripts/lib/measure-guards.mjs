// Guards for the task-list measure scripts (PAR-12747, PAR-14334): a script that writes
// to a database must reject connection-string overrides and need an explicit confirm.
import assert from "node:assert/strict";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** The only database names the seed may write to without --allow-database-name. */
export const DISPOSABLE_DATABASE_NAME = /^(?:paperclip_measure|measure_[a-z0-9_]+|[a-z0-9_]*_measure)$/;

/**
 * Validates the database url of a writing script. The host must be loopback, and the
 * url must carry no query string: postgres.js prefers the `host` and `hostaddr` query
 * parameters over the url's own host, so `?host=remote.example` would connect elsewhere.
 * The database must be named like a disposable one, or named by `confirmDatabase`.
 * @param {string | undefined} raw
 * @param {{ confirmDatabase?: string }} [options]
 */
export function assertDisposableLoopbackDatabase(raw, options = {}) {
  assert.ok(raw, "Pass --database-url=<disposable local Paperclip database>");
  // postgres.js splits userinfo at the FIRST "@" and comma-splits the host list (multihost),
  // while WHATWG URL splits at the LAST "@". Such a string can pass the host check below
  // yet dial another host first, so refuse it on the raw string.
  assert.ok(!raw.includes(","), "--database-url must name one host: a comma (multihost) is refused");
  assert.ok((raw.match(/@/g) ?? []).length <= 1, "--database-url must contain at most one \"@\" (encode it as %40 inside a password)");
  const url = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "--database-url must be a postgres:// url");
  assert.ok(LOOPBACK_HOSTS.includes(url.hostname), "Only a disposable loopback database may be seeded");
  assert.equal(url.search, "", "--database-url must not carry a query string (host, hostaddr and other overrides are refused)");
  assert.equal(url.hash, "", "--database-url must not carry a fragment");
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assert.ok(name && !name.includes("/"), "--database-url must name one database");
  assert.ok(
    DISPOSABLE_DATABASE_NAME.test(name) || options.confirmDatabase === name,
    `Refusing to seed database "${name}": name it paperclip_measure or measure_*, or pass --confirm-database=${name} to say it is disposable`,
  );
  return url.href;
}

/**
 * Validates a server url that receives the owner's bearer token: https, or http only to
 * loopback.
 * @param {string | undefined} raw
 * @param {string} flag
 */
export function assertSafeServerUrl(raw, flag) {
  assert.ok(raw, `Pass ${flag}=<server url>`);
  const url = new URL(raw);
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  assert.ok(url.protocol === "https:" || (url.protocol === "http:" && loopback), `${flag} sends the owner's token: use https, or http to a loopback host`);
  assert.ok(!url.username && !url.password, `${flag} must not carry credentials`);
  return url.origin;
}

/**
 * True when both lists hold the same ids in the same order.
 * @param {string[]} a
 * @param {string[]} b
 */
export function sameRowsInOrder(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
