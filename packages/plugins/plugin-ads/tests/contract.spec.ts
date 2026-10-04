/**
 * What the skill promises agents must exist, what the manifest declares must be what the code uses, and the cross-plugin rules every PiB plugin keeps
 * (one subscription per core event, one company.created wiring, skills within budget, no secret in a log line). Reads the plugin's own sources.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASKING_HEADING, COMPANY_MEMORY_HEADING } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { ADS_HIRE_ROLE, ADS_ROLE_SKILLS } from "../src/hire.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/platforms.js";
import { ADS_BODY, GOVERNANCE_REFERENCE, PLATFORMS_REFERENCE, SKILLS } from "../src/skills.js";
import { ADS_TOOLS } from "../src/tools.js";
import { ADS_JOBS } from "../src/cockpit.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
});
const src = (includeUi = true) => files(join(ROOT, "src")).filter((f) => includeUi || !f.includes("/ui/")).map((f) => readFileSync(f, "utf8")).join("\n");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the skill and the tools agree", () => {
  const skill = SKILLS[0]!;
  const tools = new Set(ADS_TOOLS.map((t) => t.name));

  it("every tool the skill names exists, and every tool is named in the skill", () => {
    const named = new Set([...(skill.markdown ?? "").matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1]!));
    const verbs = /^(create|get|list|update|set|add|record|propose|revise|cancel|execute|check|sync|register|acknowledge|connect)-/;
    expect([...named].filter((n) => verbs.test(n) && !tools.has(n) && !["create-client-action", "get-client-profile", "ask-owner"].includes(n))).toEqual([]);
    expect([...tools].filter((t) => !(skill.markdown ?? "").includes(`\`${t}\``) && !GOVERNANCE_REFERENCE.includes(t))).toEqual([]);
  });

  it("the other plugins' tools it names are real", async () => {
    // The path is built at run time: another plugin's sources are read, not compiled into this package.
    const load = async (name: string) => (await import(/* @vite-ignore */ fileURLToPath(new URL(`../../plugin-${name}/src/manifest.ts`, import.meta.url)))).default as { tools?: Array<{ name: string }> };
    const crm = await load("crm");
    const cockpit = await load("cockpit");
    const names = (m: { tools?: Array<{ name: string }> }) => new Set((m.tools ?? []).map((t) => t.name));
    const texts = [skill.markdown ?? "", ...(skill.files ?? []).map((f) => f.content), src(false)].join("\n");
    for (const m of texts.matchAll(/partnersinbiz\.(crm|cockpit|ads):([a-z0-9-]+)/g)) {
      const owner = m[1] === "crm" ? names(crm) : m[1] === "cockpit" ? names(cockpit) : tools;
      expect(owner.has(m[2]!), `${m[1]}:${m[2]}`).toBe(true);
    }
  });

  it("every parameter of every tool is described, and the budget holds", () => {
    const missing: string[] = [];
    for (const t of ADS_TOOLS) {
      if (!t.description?.trim()) missing.push(`${t.name} (tool)`);
      const walk = (schema: Record<string, any>, path: string) => {
        for (const [name, s] of Object.entries<Record<string, any>>(schema.properties ?? {})) {
          if (!s.description?.trim()) missing.push(`${path}${name}`);
          if (s.type === "object") walk(s, `${path}${name}.`);
        }
      };
      walk(t.parametersSchema as Record<string, any>, `${t.name}.`);
    }
    expect(missing).toEqual([]);
    expect((skill.markdown ?? "").length).toBeLessThanOrEqual(18_000);
    expect((skill.markdown ?? "").length).toBeGreaterThan(4000);
    expect(ADS_BODY.length + GOVERNANCE_REFERENCE.length + PLATFORMS_REFERENCE.length).toBeGreaterThan(8000);
  });

  it("carries the company memory and asking sections, a unique pib- slug, and the references it points at", () => {
    expect(skill.markdown).toContain(COMPANY_MEMORY_HEADING);
    expect(skill.markdown).toContain(ASKING_HEADING);
    expect(skill.slug).toBe("pib-ads");
    expect(skill.markdown).toMatch(/^---\nname: pib-ads\nslug: pib-ads\n/);
    for (const f of skill.files ?? []) expect(ADS_BODY, f.path).toContain(f.path);
    expect(ADS_ROLE_SKILLS.map((s) => s.slug)).toEqual(["pib-ads", "pib-company-os"]);
    expect(ADS_HIRE_ROLE.skills.at(-1)!.slug).toBe("pib-company-os");
  });

  it("states the rules an agent must never break", () => {
    for (const rule of [/never spend money by yourself/i, /A person approves|a person approves it/i, /never touch caps or switches|caps or switches/i, /never pauses a live campaign by itself/i, /approval runs one change once/i]) expect(ADS_BODY + GOVERNANCE_REFERENCE).toMatch(rule);
  });
});

describe("the manifest matches the package and the code", () => {
  it("has one version everywhere", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string; name: string };
    expect(manifest.version).toBe(pkg.version);
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(pkg.name).toBe("@partnersinbiz/plugin-ads");
    expect(read("README.md")).toContain(`Version ${pkg.version}`);
  });

  it("declares only the capabilities the code can use, and none it does not", () => {
    const text = code(src());
    const caps = new Set(manifest.capabilities);
    expect(caps.has("http.outbound")).toBe(false);
    expect(text).not.toMatch(/\bctx\.http\b|\bctx\.assets\b/);
    for (const [cap, pattern] of Object.entries({
      "projects.managed": /projects\.managed\./,
      "authorization.grants.write": /grants\.set\(/,
      "authorization.grants.read": /grants\.list\(/,
      "secrets.read-ref": /SecretResolver|secrets\.resolve/,
      "issues.wakeup": /requestWakeup|wakeIssue|createWorkIssue/,
      "agents.read": /ctx\.agents\./,
    })) {
      expect(pattern.test(text), cap).toBe(true);
      expect(caps.has(cap as never), cap).toBe(true);
    }
    // Not declared, not used: no routines, no managed agents, no webhooks, no core table reads.
    expect(text).not.toMatch(/routines\.managed|agents\.managed|public\./);
    expect(manifest.database).toEqual({ namespaceSlug: "ads", migrationsDir: "migrations" });
    expect((manifest as { routines?: unknown[] }).routines).toBeUndefined();
    expect((manifest as { webhooks?: unknown[] }).webhooks).toBeUndefined();
  });

  it("declares the jobs the Cockpit watches, and the worker registers each", () => {
    expect(manifest.jobs!.map((j) => j.jobKey)).toEqual(ADS_JOBS.map((j) => j.key));
    const worker = read("src/worker.ts");
    for (const j of manifest.jobs!) expect(worker, j.jobKey).toContain(`registerJob(ctx, "${j.jobKey}"`);
    expect(manifest.jobs!.find((j) => j.jobKey === "setup-status")).toBeTruthy();
  });

  it("serves the routes Setup, the Cockpit and the sign-in bridge call, and the sidebar and page slots", () => {
    expect(manifest.apiRoutes!.map((r) => r.routeKey)).toEqual(["oauth-complete", "setup-status", "cockpit"]);
    expect(manifest.ui!.slots!.map((s) => [s.type, s.exportName])).toEqual([["page", "AdsPage"], ["sidebar", "AdsSidebar"]]);
    expect(manifest.ui!.slots![0]).toMatchObject({ routePath: "ads" });
    expect(read("esbuild.config.mjs")).toContain("buildOauthBridge");
  });

  it("every action the page calls is registered by the worker", () => {
    const ui = read("src/ui/index.tsx");
    const keys = [...(/const ACTION_KEYS = \[([\s\S]*?)\] as const/.exec(ui)?.[1] ?? "").matchAll(/"(ads\.[a-z-]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(15);
    const worker = read("src/worker.ts");
    for (const key of keys) expect(worker, key).toContain(`"${key}":`);
  });
});

describe("rules every PiB plugin keeps", () => {
  it("subscribes to issue.updated once and handles company.created only through the kit's bootstrap", () => {
    const text = code(src(false));
    expect(text.match(/events\.on\(\s*["'`]issue\.updated["'`]/g)?.length ?? 0).toBe(1);
    expect(text.match(/\bregisterDoneChecks\(\s*ctx/g)?.length ?? 0).toBe(0);
    expect(text.match(/events\.on\(\s*["'`]company\.created["'`]/g)?.length ?? 0).toBe(0);
    expect(text.match(/\bregisterCompanyBootstrap\(\s*ctx/g)?.length ?? 0).toBe(1);
    expect(text.match(/\bregisterHireWatch\(/g)?.length ?? 0).toBe(1);
    // It reads the Cockpit's roles copy, so it keeps it fresh.
    expect(text).toMatch(/\bregisterRoleWatch\(\s*ctx\s*\)/);
    // No handler for the agent events besides the hire watch.
    expect(text).not.toMatch(/events\.on\(\s*["'`]agent\./);
  });

  it("has no routine whose template could break the host's dispatch", () => {
    expect((manifest as { routines?: unknown[] }).routines ?? []).toEqual([]);
  });

  it("never writes a secret into a log line, an error shown to people or an issue", () => {
    const lines = src().split("\n");
    const offenders = lines.filter((l) => /logger\.(info|warn|error|debug)\(/.test(l) && /\b(token|secret|password|accessToken|refreshToken|clientSecret|appSecret)\b(?!_enc|Enc)/i.test(l.replace(/"[^"]*"/g, "")));
    expect(offenders).toEqual([]);
    expect(code(src())).not.toMatch(/console\.(log|info|warn|error)/);
  });

  it("keeps fixtures free of anything shaped like a real key", () => {
    for (const file of files(join(ROOT, "tests"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bAC[0-9a-f]{32}\b|\b[sr]k_(live|test)_[0-9A-Za-z]{16,}|\bEAA[A-Za-z0-9]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{30,}/);
    }
  });

  it("the only code that can change an ad platform is the guarded execute path", () => {
    const callers = files(join(ROOT, "src")).filter((f) => /\.(createCampaign|setCampaignStatus|setCampaignBudget)\(/.test(code(readFileSync(f, "utf8"))));
    expect(callers.map((f) => f.slice(ROOT.length))).toEqual(["src/execute.ts"]);
  });

  it("the only code that records an approval is called from a person's action or an issue a person closed", () => {
    const worker = code(read("src/worker.ts"));
    const proposals = code(read("src/proposals.ts"));
    expect(worker.match(/recordSignoff\(/g)?.length).toBe(1);
    expect(proposals.match(/recordSignoff\(rt, \{ proposalId: p\.id, userId, role: "owner"/g)?.length).toBe(1);
    // The worker passes the person from the host's actor, never a value from the payload.
    expect(worker).toMatch(/userId: isUser \? context\.actor\.userId : null/);
    expect(worker).not.toMatch(/p\.userId|params\.userId|body\.userId/);
    // The tool path has no user at all.
    expect(worker).toMatch(/userId: null, agentId: run\.agentId/);
  });
});
