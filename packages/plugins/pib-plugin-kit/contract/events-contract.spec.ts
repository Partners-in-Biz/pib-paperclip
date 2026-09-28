/**
 * Cross-plugin contract: one host subscription per event name in each plugin.
 *
 * Every `ctx.events.on(...)` is its own host subscription, and the worker runs
 * all of a plugin's handlers for that event on each delivery. Two subscriptions
 * to `issue.updated` therefore run every `issue.updated` handler twice (double
 * approvals, double done-check reopen comments). `registerDoneChecks` counts as
 * a subscription; a plugin that already listens calls `checkDoneOnUpdate` from
 * its own handler instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"] as const;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("event subscriptions", () => {
  it.each(PLUGINS)("%s subscribes to issue.updated at most once", (plugin) => {
    const text = sources(fileURLToPath(new URL(`../../plugin-${plugin}/src`, import.meta.url))).map((file) => readFileSync(file, "utf8")).join("\n");
    const direct = text.match(/events\.on\(\s*["'`]issue\.updated["'`]/g)?.length ?? 0;
    const viaKit = text.match(/\bregisterDoneChecks\(\s*ctx/g)?.length ?? 0;
    expect(direct + viaKit, "use checkDoneOnUpdate inside the one issue.updated handler").toBeLessThanOrEqual(1);
  });
});
