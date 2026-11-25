// PAR-13538 / PAR-9915: seats that share one HERMES_HOME get a skills dir per
// agent, so each prompt lists only that agent's skills and one seat's run never
// removes or leaks another seat's links.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

import { execute } from "./execute.js";
import {
  HERMES_AGENT_SKILLS_DIR_ENV,
  hermesProfileUsesAgentSkillsDir,
  reconcileHermesPaperclipSkills,
  resolveHermesAgentSkillsDir,
  syncHermesSkills,
} from "./skills.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPT_IN = `skills:\n  external_dirs:\n    - \${${HERMES_AGENT_SKILLS_DIR_ENV}}\n`;

describe("hermesProfileUsesAgentSkillsDir", () => {
  it.each([
    ["block list", OPT_IN, true],
    ["flow list", `model:\n  default: x\nskills:\n  external_dirs: ["\${${HERMES_AGENT_SKILLS_DIR_ENV}}"]\n`, true],
    ["after other skills keys", `skills:\n  disabled: []\n  external_dirs:\n  - /opt/shared\n  - $${HERMES_AGENT_SKILLS_DIR_ENV}\n`, true],
    ["commented out", `skills:\n  external_dirs:\n    # - \${${HERMES_AGENT_SKILLS_DIR_ENV}}\n`, false],
    ["other skills key", `skills:\n  create_dir: \${${HERMES_AGENT_SKILLS_DIR_ENV}}\n`, false],
    ["other top-level section", `terminal:\n  external_dirs:\n    - \${${HERMES_AGENT_SKILLS_DIR_ENV}}\n`, false],
    ["no skills section", "model:\n  default: x\n", false],
  ])("%s", (_label, yaml, expected) => {
    expect(hermesProfileUsesAgentSkillsDir(yaml)).toBe(expected);
  });
});

describe("per-agent Hermes skills dir", () => {
  let root: string;
  let hermesHome: string;
  let sharedSkills: string;
  let skillsRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-agent-skills-"));
    hermesHome = path.join(root, "profiles", "shared");
    sharedSkills = path.join(hermesHome, "skills");
    skillsRoot = path.join(root, "skills", COMPANY);
    await fs.mkdir(sharedSkills, { recursive: true });
    await fs.writeFile(path.join(hermesHome, "config.yaml"), OPT_IN, "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function skill(name: string) {
    const source = path.join(skillsRoot, "__runtime__", name);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
    return { key: `company/${COMPANY}/${name}`, runtimeName: name, source };
  }

  async function companySkills() {
    return Promise.all(["alpha--0000000001", "beta--0000000002", "gamma--0000000003", "delta--0000000004"].map(skill));
  }

  function config(entries: Array<{ key: string; runtimeName: string; source: string }>, desired: string[]) {
    return {
      env: { HERMES_HOME: hermesHome },
      paperclipRuntimeSkills: entries,
      paperclipSkillSync: { desiredSkills: desired },
    };
  }

  async function linkNames(dir: string) {
    const names: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) names.push(entry.name);
    }
    return names.sort();
  }

  it("gives two agents on the same HERMES_HOME disjoint skill sets and leaves the shared dir clean", async () => {
    const [alpha, beta, gamma, delta] = await companySkills();
    const all = [alpha, beta, gamma, delta];
    const dirA = await resolveHermesAgentSkillsDir(config(all, []), AGENT_A);
    const dirB = await resolveHermesAgentSkillsDir(config(all, []), AGENT_B);
    expect(dirA).toBe(path.join(hermesHome, "paperclip-agents", AGENT_A, "skills"));
    expect(dirB).toBe(path.join(hermesHome, "paperclip-agents", AGENT_B, "skills"));

    await reconcileHermesPaperclipSkills(config(all, [alpha.key, beta.key]), undefined, { agentSkillsDir: dirA });
    await reconcileHermesPaperclipSkills(config(all, [gamma.key, delta.key]), undefined, { agentSkillsDir: dirB });
    // Agent A runs again after B: it must not touch B's links.
    await reconcileHermesPaperclipSkills(config(all, [alpha.key, beta.key]), undefined, { agentSkillsDir: dirA });

    const linksA = await linkNames(dirA!);
    const linksB = await linkNames(dirB!);
    expect(linksA).toEqual([alpha.runtimeName, beta.runtimeName]);
    expect(linksB).toEqual([delta.runtimeName, gamma.runtimeName]);
    expect(linksA.filter((name) => linksB.includes(name))).toEqual([]);
    expect(await fs.realpath(path.join(dirA!, alpha.runtimeName))).toBe(await fs.realpath(alpha.source));
    expect(await linkNames(sharedSkills)).toEqual([]);
  });

  it("drops a skill unassigned from the agent and clears old shared links, keeping Hermes' own skills", async () => {
    const [alpha, beta, gamma] = await companySkills();
    const all = [alpha, beta, gamma];
    // State from the shared-dir era: Paperclip links (one dangling), an
    // unrelated link and a Hermes skill folder.
    await fs.symlink(alpha.source, path.join(sharedSkills, alpha.runtimeName));
    await fs.symlink(gamma.source, path.join(sharedSkills, gamma.runtimeName));
    await fs.symlink(path.join(skillsRoot, "__runtime__", "gone"), path.join(sharedSkills, beta.runtimeName));
    const foreign = path.join(root, "elsewhere", alpha.runtimeName);
    await fs.mkdir(foreign, { recursive: true });
    await fs.symlink(foreign, path.join(sharedSkills, "user-linked"));
    await fs.mkdir(path.join(sharedSkills, "hermes-agent"), { recursive: true });

    const dirA = await resolveHermesAgentSkillsDir(config(all, []), AGENT_A);
    const lines: string[] = [];
    await reconcileHermesPaperclipSkills(config(all, [alpha.key, beta.key]), undefined, {
      agentSkillsDir: dirA,
      onLog: (line) => { lines.push(line); },
    });
    expect(await linkNames(dirA!)).toEqual([alpha.runtimeName, beta.runtimeName]);
    expect(await linkNames(sharedSkills)).toEqual(["user-linked"]);
    expect((await fs.lstat(path.join(sharedSkills, "hermes-agent"))).isDirectory()).toBe(true);
    expect(lines.some((line) => line.includes("Removed 3 Paperclip skill link(s)"))).toBe(true);

    await reconcileHermesPaperclipSkills(config(all, [alpha.key]), undefined, { agentSkillsDir: dirA });
    expect(await linkNames(dirA!)).toEqual([alpha.runtimeName]);
  });

  it("keeps the shared skills dir when the profile has not opted in", async () => {
    const [alpha, beta] = await companySkills();
    await fs.writeFile(path.join(hermesHome, "config.yaml"), "skills:\n  external_dirs: []\n", "utf8");
    expect(await resolveHermesAgentSkillsDir(config([alpha, beta], []), AGENT_A)).toBeNull();
    await syncHermesSkills(
      { adapterType: "hermes_local", agentId: AGENT_A, companyId: COMPANY, config: config([alpha, beta], []) },
      [alpha.key],
    );
    expect(await linkNames(sharedSkills)).toEqual([alpha.runtimeName]);
    await expect(fs.stat(path.join(hermesHome, "paperclip-agents"))).rejects.toThrow();
  });

  it("refuses an agent id that is not a single path segment", async () => {
    expect(await resolveHermesAgentSkillsDir(config([], []), "../escape")).toBeNull();
    expect(await resolveHermesAgentSkillsDir(config([], []), "")).toBeNull();
  });

  it("syncs the UI's desired skills into the agent's own dir", async () => {
    const [alpha, beta] = await companySkills();
    await syncHermesSkills(
      { adapterType: "hermes_local", agentId: AGENT_B, companyId: COMPANY, config: config([alpha, beta], []) },
      [beta.key],
    );
    expect(await linkNames(path.join(hermesHome, "paperclip-agents", AGENT_B, "skills"))).toEqual([beta.runtimeName]);
    expect(await linkNames(sharedSkills)).toEqual([]);
  });

  it("points only this run's Hermes process at the agent's own dir", async () => {
    const [alpha] = await companySkills();
    const command = path.join(root, "hermes.cjs");
    const capture = path.join(root, "env.jsonl");
    await fs.writeFile(command, `#!${process.execPath}
require("node:fs").appendFileSync(process.env.CAPTURE_PATH, JSON.stringify({ dir: process.env.${HERMES_AGENT_SKILLS_DIR_ENV} ?? null }) + "\\n");
console.log("done\\nsession_id: 20261119_000000_abcdef");
`, { mode: 0o700 });
    const run = (agentId: string, env: Record<string, string>): AdapterExecutionContext => ({
      runId: `run-${agentId}`,
      agent: { id: agentId, companyId: COMPANY, name: "Hermes fixture", adapterType: "hermes_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        ...config([alpha], [alpha.key]),
        hermesCommand: command, provider: "openrouter", model: "fixture-model", cwd: root,
        env: { HERMES_HOME: hermesHome, CAPTURE_PATH: capture, ...env },
        persistSession: false, timeoutSec: 10, graceSec: 1,
      },
      context: {},
      onLog: async () => {},
    }) as AdapterExecutionContext;

    await execute(run(AGENT_A, { [HERMES_AGENT_SKILLS_DIR_ENV]: "/somewhere/else" }));
    await fs.writeFile(path.join(hermesHome, "config.yaml"), "skills: {}\n", "utf8");
    await execute(run(AGENT_B, { [HERMES_AGENT_SKILLS_DIR_ENV]: "/somewhere/else" }));

    const [first, second] = (await fs.readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(first.dir).toBe(path.join(hermesHome, "paperclip-agents", AGENT_A, "skills"));
    expect(second.dir).toBeNull();
    expect(await linkNames(first.dir)).toEqual([alpha.runtimeName]);
  });
});
