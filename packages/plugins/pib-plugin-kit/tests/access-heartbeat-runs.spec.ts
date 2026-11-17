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
        .map((f) => f.slice(PLUGINS.length + 1)),
    );
    expect(offenders).toEqual([]);
  });

  it("the kit queries it in one place, selecting only the person and the status", () => {
    const kit = sources(join(PLUGIN_KIT_ROOT, "src")).filter(mentions).map((f) => f.slice(PLUGIN_KIT_ROOT.length + 1));
    expect(kit).toEqual(["src/access/acting-person.ts"]);
    expect(ACTING_PERSON_SQL.replace(/\s+/g, " ")).toBe(
      "SELECT responsible_user_id, status FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
    );
  });
});
