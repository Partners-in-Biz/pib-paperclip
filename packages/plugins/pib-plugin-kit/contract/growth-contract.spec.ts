/**
 * Cross-plugin contract: the Growth Lab (W5).
 *
 * 1. Every plugin manifest that declares a `measure-experiments` job also
 *    declares all eight kit growth tools (`GROWTH_TOOL_NAMES`). A job that
 *    measures experiments nobody can propose or approve is dead weight.
 * 2. Every tool name in `references/growth-lab.md` (backticked, tool-like)
 *    exists in the kit's tool list or as a job on a plugin that runs the lab.
 * 3. The reference names all eight tools.
 *
 * Ads joins `PLUGINS` when it is installed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GROWTH_TOOL_NAMES } from "../src/index.js";

type Manifest = { id: string; tools?: Array<{ name: string }>; jobs?: Array<{ jobKey: string }> };

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"] as const;
const JOB = "measure-experiments";
const reference = readFileSync(fileURLToPath(new URL("../references/growth-lab.md", import.meta.url)), "utf8");

describe("growth lab contract", async () => {
  const manifests: Manifest[] = [];
  for (const p of PLUGINS) manifests.push((await import(`../../plugin-${p}/src/manifest.ts`)).default as Manifest);
  const withJob = manifests.filter((m) => (m.jobs ?? []).some((j) => j.jobKey === JOB));

  it("at least one plugin runs the lab", () => {
    expect(withJob.length).toBeGreaterThanOrEqual(1);
  });

  it.each(withJob.map((m) => [m.id, m] as const))("%s declares the eight growth tools", (_id, m) => {
    const names = new Set((m.tools ?? []).map((t) => t.name));
    const missing = GROWTH_TOOL_NAMES.filter((n) => !names.has(n));
    expect(missing, `${m.id} has a ${JOB} job but no ${missing.join(", ")}: spread growthToolDeclarations() into its tools`).toEqual([]);
  });

  it("the reference names all eight tools", () => {
    for (const name of GROWTH_TOOL_NAMES) expect(reference, `growth-lab.md never names ${name}`).toContain(`\`${name}\``);
  });

  it("every tool-like name in the reference exists", () => {
    const known = new Set<string>([...GROWTH_TOOL_NAMES, JOB]);
    const named = [...reference.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!);
    const unknown = named.filter((n) => !known.has(n));
    expect(unknown, "growth-lab.md names tools that do not exist").toEqual([]);
  });
});
