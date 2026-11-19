/**
 * Cross-plugin contract: nothing waits for the managed-skill sync unless it is
 * listed here with the reason.
 *
 * `ensure` waits for the host, and on a company with many skills the host can
 * take more than 30 seconds for one skill. A tool call, a page action or an API
 * route that waits for it runs into the host's 30-second limit after every
 * worker restart (13 Nov 2026: a Cockpit release and a CRM and Mailbox release
 * rolled back at their smoke tests). Those callers use the syncer's `soon`
 * (kit `createSkillSyncGuard`): at most 2 seconds, never throws, and a failed
 * sync is left alone for 5 minutes.
 *
 * So every `.ensure(` on a skill syncer in a plugin's worker code must be in
 * `WAITS` below: a new company's bootstrap, a background sync at start, a job
 * that hands work to an agent right after, or the inside of a composite that
 * `soon` wraps. A new one fails this test: switch it to `soon`, or add it here
 * and say why it must wait.
 *
 * It reads plugin sources, so run it after changing any plugin's worker.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGINS_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** `<plugin folder>/<file under src>` -> how many waiting calls it may hold, and why. */
const WAITS: Record<string, { count: number; why: string }> = {
  "plugin-crm/worker.ts": { count: 2, why: "company.created (an event), and the background sync of known companies at start (not awaited by setup)." },
  "plugin-partners/worker.ts": { count: 1, why: "company.created (an event)." },
  "plugin-payroll/worker.ts": { count: 1, why: "company.created (an event)." },
  "plugin-seo/worker.ts": { count: 1, why: "company.created (an event)." },
  "plugin-seo/service/jobs.ts": { count: 2, why: "The daily and weekly jobs open issues for the SEO agent right after, so its skill text must be current." },
  "plugin-seo/service/common.ts": { count: 2, why: "The two syncers inside the composite `ensure`; `soon` wraps that composite." },
  "plugin-social/company.ts": { count: 2, why: "The two syncers inside `syncBoth`; the bounded guard wraps it and only a new company's bootstrap waits for it." },
};

/** A skill syncer as the plugins name it (`skillSync`, `skills`, `e.skills`, `env.skills`, `ownSkills`, `shared`, `own`, `syncer`). */
const WAITING_CALL = /\b(?:skillSync|skills|ownSkills|shared|own|syncer|skillSyncer)\??\.ensure\(/g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "ui") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Every plugin folder that uses the kit. */
function kitPlugins(): string[] {
  return readdirSync(PLUGINS_DIR)
    .filter((name) => name.startsWith("plugin-") && existsSync(join(PLUGINS_DIR, name, "package.json")) && existsSync(join(PLUGINS_DIR, name, "src")))
    .filter((name) => readFileSync(join(PLUGINS_DIR, name, "package.json"), "utf8").includes("@partnersinbiz/pib-plugin-kit"))
    .sort();
}

function waitingCalls(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const plugin of kitPlugins()) {
    const src = join(PLUGINS_DIR, plugin, "src");
    for (const file of sources(src)) {
      const count = readFileSync(file, "utf8").match(WAITING_CALL)?.length ?? 0;
      if (count > 0) found[`${plugin}/${relative(src, file).split("\\").join("/")}`] = count;
    }
  }
  return found;
}

describe("skill sync wait contract", () => {
  it("reads the plugins that use the kit", () => {
    expect(kitPlugins()).toEqual(expect.arrayContaining(["plugin-accounting", "plugin-billing", "plugin-campaigns", "plugin-cockpit", "plugin-crm", "plugin-mailbox", "plugin-partners", "plugin-payroll", "plugin-seo", "plugin-social"]));
  });

  it("no tool call, page action or route waits for the skill sync: every waiting `ensure` is listed with its reason", () => {
    const found = waitingCalls();
    const problems: string[] = [];
    for (const [file, count] of Object.entries(found)) {
      const allowed = WAITS[file]?.count ?? 0;
      if (count > allowed) problems.push(`${file}: ${count} call(s) wait on the skill sync through ensure, ${allowed} listed. Use the syncer's soon(companyId) in a tool call, page action or route, or list the call in WAITS with the reason it must wait.`);
    }
    expect(problems).toEqual([]);
  });

  it("the list has no entry that is no longer needed", () => {
    const found = waitingCalls();
    const stale = Object.entries(WAITS)
      .filter(([file, entry]) => (found[file] ?? 0) < entry.count)
      .map(([file, entry]) => `${file}: lists ${entry.count}, found ${found[file] ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("every entry says why it waits", () => {
    for (const entry of Object.values(WAITS)) expect(entry.why.length).toBeGreaterThan(20);
  });
});
