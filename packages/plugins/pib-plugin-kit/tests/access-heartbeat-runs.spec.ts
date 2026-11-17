/**
 * PAR-12578 plan, section 9: the plugins that gain `heartbeat_runs` for the guard
 * (stage A3) may read it only through the kit's `actingPersonForRun`, which
 * selects the person and status by run id. This fails when such a plugin gets
 * any other query on the table.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTING_PERSON_SQL } from "../src/access/acting-person.js";
import { PLUGIN_KIT_ROOT } from "./helpers/pg.js";

const PLUGINS = join(PLUGIN_KIT_ROOT, "..");
// Plugins that read `heartbeat_runs` for their own work before stage A. Every other plugin gains it with A3.
const READ_BEFORE_A = ["plugin-campaigns", "plugin-cockpit", "plugin-crm", "plugin-seo", "plugin-social", "plugin-studio"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(p);
    return /\.(ts|tsx|js|mjs|sql)$/.test(name) ? [p] : [];
  });
}

const mentions = (file: string) => /heartbeat_runs/.test(readFileSync(file, "utf8"));
const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/**
 * The one other query, allowed by name and exact text: Setup's confirm list
 * before enforce counts the runs that worked per person (plan, 4.3). It returns
 * counts only, filtered by company and person, never a run's context.
 */
const ALLOWED: Record<string, string> = {
  "plugin-setup/src/access-switch.ts": `SELECT responsible_user_id, COUNT(*)::int AS runs FROM public.heartbeat_runs WHERE company_id = $1 AND responsible_user_id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND status = 'succeeded' AND created_at >= $3 GROUP BY responsible_user_id`,
};

describe("heartbeat_runs in guarded plugins", () => {
  const gaining = readdirSync(PLUGINS).filter((d) => d.startsWith("plugin-") && !READ_BEFORE_A.includes(d) && statSync(join(PLUGINS, d, "src"), { throwIfNoEntry: false })?.isDirectory());

  it("finds the plugins to check", () => {
    expect(gaining.length).toBeGreaterThan(5);
    for (const d of READ_BEFORE_A) expect(sources(join(PLUGINS, d, "src")).some(mentions), d).toBe(true);
  });

  it("the plugins that gain it have no query on it (only the manifest may name it)", () => {
    const offenders = gaining.flatMap((d) =>
      sources(join(PLUGINS, d, "src"))
        .filter((f) => !/[\\/]manifest\.ts$/.test(f) && mentions(f))
        .map((f) => f.slice(PLUGINS.length + 1).replace(/\\/g, "/"))
        .filter((f) => !Object.hasOwn(ALLOWED, f)),
    );
    expect(offenders).toEqual([]);
  });

  it("an allowed file names the table once, inside its exact query", () => {
    for (const [file, sql] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(PLUGINS, file), "utf8");
      expect(text.match(/heartbeat_runs/g), file).toHaveLength(1);
      const literal = text.match(/`(SELECT[^`]*heartbeat_runs[^`]*)`/);
      expect(literal && oneLine(literal[1]!), file).toBe(sql);
    }
  });

  it("the kit queries it in one place, selecting only the person and the status", () => {
    const kit = sources(join(PLUGIN_KIT_ROOT, "src")).filter(mentions).map((f) => f.slice(PLUGIN_KIT_ROOT.length + 1));
    expect(kit).toEqual(["src/access/acting-person.ts"]);
    expect(ACTING_PERSON_SQL.replace(/\s+/g, " ")).toBe(
      "SELECT responsible_user_id, status FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
    );
  });
});
