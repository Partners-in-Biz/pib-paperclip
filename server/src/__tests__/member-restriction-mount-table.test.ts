import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_RESTRICTION_MOUNT_TABLE,
  type MemberRestrictionMountEntry,
} from "../services/member-restriction/route-table.js";

// PAR-12608 4.6 (X3) and 4.6a, AC-M8: the build fails when a registration on
// the app in `app.ts` or a socket upgrade handler has no row in the mount table.

const SERVER_SRC = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_SRC, "../..");

/** The top-level arguments of the call whose "(" is at `open`; strings and comments are skipped. */
function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\"" || c === "'" || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
    } else if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i);
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) + 1;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) return [...args, source.slice(start, i)];
    else if (c === "," && depth === 1) { args.push(source.slice(start, i)); start = i + 1; }
  }
  throw new Error(`unbalanced call at ${open}`);
}

/** An argument by its leading name: a string literal, a (dotted) name, or `<inline>` for a function. */
function leadingName(arg: string) {
  const text = arg.trim();
  const literal = /^["'`]([^"'`]*)["'`]/.exec(text);
  if (literal) return `"${literal[1]}"`;
  if (/^(?:\(|async\b|function\b)/.test(text)) return "<inline>";
  return /^[A-Za-z_$][\w$.]*/.exec(text)?.[0] ?? "<expression>";
}

/** `app.use(...)`, `app.get(...)` and the like in `app.ts`, as the mount table names them. */
export function appRegistrations(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bapp\.(use|get|post|put|patch|delete|all|head|options|route|param)\s*\(/g)) {
    const lineStart = source.lastIndexOf("\n", match.index!) + 1;
    if (/^\s*(?:\/\/|\*)/.test(source.slice(lineStart, match.index!))) continue;
    const args = callArguments(source, match.index! + match[0].length - 1);
    found.push(`${match[1]!.toUpperCase()} ${args.filter((arg) => arg.trim()).map(leadingName).join(" ")}`);
  }
  return found;
}

/**
 * The socket upgrade handlers in one file, one entry per handler: an `upgrade`
 * listener on any receiver (`server`, `httpServer`, a client request) by any
 * way to add one, and a `WebSocketServer` that attaches its own (no `noServer`).
 */
export function upgradeHandlersIn(file: string, source: string): string[] {
  const code = source.split("\n").filter((line) => !/^\s*(?:\/\/|\*)/.test(line)).join("\n");
  const listeners = code.match(/\.(?:on|once|addListener|prependListener|prependOnceListener)\(\s*["'`]upgrade["'`]/g) ?? [];
  const servers = [...code.matchAll(/\bnew\s+(?:\w+\.)?WebSocketServer\s*\(/g)]
    .filter((match) => !/\bnoServer\s*:\s*true\b/.test(callArguments(code, match.index! + match[0].length - 1).join(",")));
  return Array.from({ length: listeners.length + servers.length }, () => `UPGRADE ${file}`);
}

/** Every socket upgrade handler in the non-test files under `server/src`. */
function upgradeHandlers(dir = SERVER_SRC): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") found.push(...upgradeHandlers(file));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(...upgradeHandlersIn(path.relative(SERVER_SRC, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8")));
    }
  }
  return found;
}

/** The routes a router file registers inside `from` up to `to` (row 5). */
function routerRoutes(file: string, from: string, to?: string) {
  const source = fs.readFileSync(path.join(SERVER_SRC, file), "utf8");
  const start = source.indexOf(from);
  const body = source.slice(start, to ? source.indexOf(to, start) : undefined);
  return [...body.matchAll(/\brouter\.(get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/g)]
    .map((match) => `${match[1]!.toUpperCase()} ${match[2]}`);
}

export function mountTableScanErrors(
  table: readonly MemberRestrictionMountEntry[],
  registrations: readonly string[],
  readTest: (repoPath: string) => string | null,
) {
  const errors: string[] = [];
  const rowOf = new Map<string, MemberRestrictionMountEntry>();
  const count = (list: readonly string[], item: string) => list.filter((value) => value === item).length;
  for (const entry of table) {
    for (const mount of new Set(entry.mounts)) {
      if (rowOf.has(mount)) errors.push(`${mount}: named by two rows`);
      rowOf.set(mount, entry);
      if (!registrations.includes(mount)) errors.push(`${mount} (row ${entry.row}): no such registration; remove or correct the row`);
      // A name the scan cannot tell apart (`<inline>`, an upgrade handler's file) is listed once per registration, so a new one still fails.
      else if (count(registrations, mount) !== count(entry.mounts, mount)) {
        errors.push(`${mount} (row ${entry.row}): ${count(registrations, mount)} registrations, ${count(entry.mounts, mount)} in the row`);
      }
    }
    if (entry.toProve && !/^PAR-\d+$/.test(entry.toProve)) {
      const test = readTest(entry.toProve);
      if (test === null) errors.push(`row ${entry.row}: to-prove test ${entry.toProve} does not exist`);
      else if (!test.includes(`4.6a row ${entry.row}`)) errors.push(`row ${entry.row}: test ${entry.toProve} does not name "4.6a row ${entry.row}"`);
    }
  }
  for (const registration of new Set(registrations)) {
    if (!rowOf.has(registration)) errors.push(`${registration}: no row in the mount table of 4.6a`);
  }
  return errors.sort();
}

describe("member restriction mount table scan (4.6a, AC-M8)", () => {
  const readTest = (repoPath: string) => {
    const file = path.resolve(REPO_ROOT, repoPath);
    return file.startsWith(REPO_ROOT + path.sep) && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const appSource = fs.readFileSync(path.join(SERVER_SRC, "app.ts"), "utf8");

  it("every registration in app.ts and every upgrade handler has a row, and every row a registration", () => {
    const registrations = [...appRegistrations(appSource), ...upgradeHandlers()];
    // The scanner sees the known entry points (a parser that finds nothing would pass).
    expect(registrations).toEqual(expect.arrayContaining([
      "USE \"/api/customer-success/v1\" customerSuccessRoutes", "USE \"/api\" api", "UPGRADE realtime/live-events-ws.ts",
      "UPGRADE realtime/runner-prp-ws.ts", "GET \"/api/chat-github/identity/callback\" <inline>",
    ]));
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, registrations, readTest)).toEqual([]);
  });

  it("fails when a test mount is added to app.ts without a row, or a row loses its mount", () => {
    const withTestMount = appSource.replace("app.use(staticUi);", "app.use(\"/api/test-mount\", testMountRoutes(db));\n  app.use(staticUi);");
    expect(withTestMount).not.toBe(appSource);
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, [...appRegistrations(withTestMount), ...upgradeHandlers()], readTest))
      .toEqual(["USE \"/api/test-mount\" testMountRoutes: no row in the mount table of 4.6a"]);
    const withInline = appSource.replace("app.use(staticUi);", "app.use((_req, _res, next) => next());\n  app.use(staticUi);");
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, [...appRegistrations(withInline), ...upgradeHandlers()], readTest))
      .toEqual(["USE <inline> (row null): 2 registrations, 1 in the row"]);
    const withoutLlms = appSource.replace("app.use(llmRoutes(db));", "");
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, [...appRegistrations(withoutLlms), ...upgradeHandlers()], readTest))
      .toEqual(["USE llmRoutes (row 9): no such registration; remove or correct the row"]);
    const withRoute = appSource.replace("app.use(staticUi);", "app.route(\"/api/x\").get(handler);\n  app.use(staticUi);");
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, [...appRegistrations(withRoute), ...upgradeHandlers()], readTest))
      .toEqual(["ROUTE \"/api/x\": no row in the mount table of 4.6a"]);
    expect(mountTableScanErrors([{ row: 2, rule: "x", mounts: ["USE a"], toProve: "missing.test.ts" },
      { row: 9, rule: "x", mounts: ["USE a"], toProve: "PAR-1" }], ["USE a", "UPGRADE b.ts"], readTest)).toEqual([
      "UPGRADE b.ts: no row in the mount table of 4.6a", "USE a: named by two rows",
      "row 2: to-prove test missing.test.ts does not exist",
    ]);
  });

  it("fails on an upgrade handler however it is written, and on a second one in a listed file", () => {
    const writings = [
      "httpServer.on(\"upgrade\", handle);", "srv.once('upgrade', handle);", "server.addListener(\"upgrade\", handle);",
      "this.server.prependListener(\n    `upgrade`,\n    handle,\n  );", "new WebSocketServer({ server, path: \"/x\" });",
      "new ws.WebSocketServer({ port: 9 });",
    ];
    for (const writing of writings) {
      const registrations = [...appRegistrations(appSource), ...upgradeHandlers(), ...upgradeHandlersIn("realtime/zz-mutation-ws.ts", writing)];
      expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, registrations, readTest), writing)
        .toEqual(["UPGRADE realtime/zz-mutation-ws.ts: no row in the mount table of 4.6a"]);
    }
    expect(upgradeHandlersIn("a.ts", "new WebSocketServer({ noServer: true });\n// server.on(\"upgrade\", x);")).toEqual([]);
    const liveEvents = fs.readFileSync(path.join(SERVER_SRC, "realtime/live-events-ws.ts"), "utf8");
    const second = [...appRegistrations(appSource), ...upgradeHandlers(),
      ...upgradeHandlersIn("realtime/live-events-ws.ts", "server.on(\"upgrade\", other);")];
    expect(liveEvents).toMatch(/\.on\(\s*"upgrade"/);
    expect(mountTableScanErrors(MEMBER_RESTRICTION_MOUNT_TABLE, second, readTest))
      .toEqual(["UPGRADE realtime/live-events-ws.ts (row 17): 2 registrations, 1 in the row"]);
  });

  it("row 5: every route of the two mounted routers is classified run or closed, and no other", () => {
    const routes = [
      ...routerRoutes("routes/connection-intents.ts", "export function runtimeConnectionIntentRoutes", "export function connectionIntentBoardRoutes"),
      ...routerRoutes("routes/native-run-mcp.ts", "export function nativeRunMcpRoutes"),
    ];
    const row5 = MEMBER_RESTRICTION_MOUNT_TABLE.find((entry) => entry.row === 5)!;
    expect(row5.routes!.map((route) => `${route.method} ${route.path}`).sort()).toEqual(routes.sort());
  });
});
