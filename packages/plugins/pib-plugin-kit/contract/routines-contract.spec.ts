/**
 * Cross-plugin contract: a managed routine must be dispatchable.
 *
 * The rule (kit `ROUTINE_ORIGIN_RULE`): a routine's `issueTemplate.originId`
 * is allowed only together with `surfaceVisibility: "plugin_operation"`.
 * Without it the host creates the issue with originKind `routine_execution`,
 * whose originId must be the routine's own uuid; the heartbeat then queries
 * `routine_runs.routine_id = origin_id` (a uuid column), so a text originId
 * such as `routine:seo-run-today` throws "invalid input syntax for type uuid",
 * the host deletes the issue, marks the routine run failed and does it again
 * on every firing. Host sources: server heartbeat `getRoutineEnvForExecutionIssue`
 * (heartbeat.js ~6998 live) and routines.js ~1370 (`issueOriginKind`,
 * `issueOriginId`). Live evidence 2026-10-03: "Run today's SEO" failed 5 of 5.
 *
 * Reads every `packages/plugins/plugin-* /src/manifest.ts`, so a new plugin is
 * covered without listing it. Run with `pnpm test:contract` (also in `pnpm test`).
 * `PIB_PLUGINS_DIR=<another copy of packages/plugins>` replays it against that
 * copy (how it was shown to fail on the committed SEO and Social manifests:
 * partnersinbiz.seo / seo-run-today, seo-weekly-review and partnersinbiz.social
 * / plan-next-week).
 *
 * Scope: manifests only. The host dispatches from the issue template stored on
 * a routine's plugin binding (`plugin_managed_resources.defaults_json`, written
 * when the plugin reconciles the routine), not from the manifest, so a routine
 * created before a manifest fix keeps failing until the plugin re-applies its
 * template. This test cannot see that; the Cockpit's routine health check
 * (kit `routineHealth`) reads the stored template and names it.
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { issueTemplateProblem, ROUTINE_ORIGIN_RULE } from "../src/routine-health.js";

type Routine = { routineKey: string; issueTemplate?: { surfaceVisibility?: string | null; originId?: string | null } | null };
type Manifest = { id: string; routines?: Routine[] };

/** `PIB_PLUGINS_DIR` points the contract at another copy of `packages/plugins` (used to replay it against an older commit). */
const PLUGINS_DIR = process.env.PIB_PLUGINS_DIR ? pathToFileURL(`${process.env.PIB_PLUGINS_DIR.replace(/\/$/, "")}/`) : new URL("../../", import.meta.url);

/** `plugin-seo` → its manifest, for every plugin package that has one. */
async function loadAllManifests(): Promise<Array<{ dir: string; manifest: Manifest }>> {
  const out: Array<{ dir: string; manifest: Manifest }> = [];
  for (const dir of readdirSync(PLUGINS_DIR).filter((name) => name.startsWith("plugin-")).sort()) {
    const file = new URL(`${dir}/src/manifest.ts`, PLUGINS_DIR);
    if (!existsSync(file)) continue;
    out.push({ dir, manifest: (await import(/* @vite-ignore */ fileURLToPath(file))).default as Manifest });
  }
  return out;
}

/** One line per routine that breaks the rule: `<plugin id> / <routine key>: <what is wrong>`. */
function routineViolations(manifest: Manifest): string[] {
  return (manifest.routines ?? []).flatMap((routine) => {
    const problem = issueTemplateProblem(routine.issueTemplate);
    return problem ? [`${manifest.id} / ${routine.routineKey}: ${problem}`] : [];
  });
}

describe("routine issue templates (fixtures)", () => {
  it("passes a compliant manifest: no originId, or originId with plugin_operation", () => {
    expect(
      routineViolations({
        id: "fixture.good",
        routines: [
          { routineKey: "plain" },
          { routineKey: "empty-template", issueTemplate: {} },
          { routineKey: "billing-only", issueTemplate: { surfaceVisibility: "default" } },
          { routineKey: "operation", issueTemplate: { surfaceVisibility: "plugin_operation", originId: "routine:index-refresh" } },
        ],
      }),
    ).toEqual([]);
  });

  it("fails the pattern that broke the live SEO and Social routines, naming each routine", () => {
    expect(
      routineViolations({
        id: "fixture.bad",
        routines: [
          { routineKey: "seo-run-today", issueTemplate: { originId: "routine:seo-run-today" } },
          { routineKey: "weekly-plan", issueTemplate: { originId: "routine:weekly-plan", surfaceVisibility: "default" } },
          { routineKey: "ok", issueTemplate: { originId: "routine:ok", surfaceVisibility: "plugin_operation" } },
        ],
      }),
    ).toEqual([
      'fixture.bad / seo-run-today: issueTemplate.originId is "routine:seo-run-today" but surfaceVisibility is not set',
      'fixture.bad / weekly-plan: issueTemplate.originId is "routine:weekly-plan" but surfaceVisibility is "default"',
    ]);
  });
});

describe("routine issue templates (every plugin manifest)", async () => {
  const manifests = await loadAllManifests();

  it("finds the PiB plugins and the routines they declare", () => {
    const ids = manifests.map((m) => m.manifest.id);
    for (const id of ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"]) expect(ids, `partnersinbiz.${id}`).toContain(`partnersinbiz.${id}`);
    expect(manifests.flatMap((m) => m.manifest.routines ?? []).length).toBeGreaterThan(0);
  });

  it.each(manifests.map((m) => [m.dir, m.manifest] as const))("%s declares only dispatchable routines", (_dir, manifest) => {
    expect(routineViolations(manifest), ROUTINE_ORIGIN_RULE).toEqual([]);
  });
});
