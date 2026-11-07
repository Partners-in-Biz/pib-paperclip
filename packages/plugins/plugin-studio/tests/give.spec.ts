import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  owner: null as { kind: string; id: string; name: string } | null,
  links: [] as Array<{ assetId: string; type: string; targetId: string }>,
  gets: 0,
}));

vi.mock("../src/assets.js", () => ({
  getAssetRow: async () => {
    if (!state.row) throw new Error("Asset not found");
    return state.row;
  },
  addLink: async (_ctx: unknown, _co: string, assetId: string, type: string, targetId: string) => void state.links.push({ assetId, type, targetId }),
}));
vi.mock("../src/scope.js", () => ({ clientOfProject: async () => state.owner }));
vi.mock("../src/config.js", () => ({ StudioConfig: class { async bucket() { return { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }; } } }));
vi.mock("../src/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage.js")>()),
  getObject: async () => {
    state.gets += 1;
    return PNG;
  },
}));

const { agentChoice, giveAsset, giveChoices, giveDescription, givenIssues, giveTitle } = await import("../src/give.js");
const { GIVEN_DIR, sweepLocalCopies } = await import("../src/storage.js");

const CO = "11111111-1111-4111-8111-111111111111";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EDITOR = { userId: "user-1", role: "member" };

const AGENTS = [
  { id: "a-local", name: "Writer", title: "Copywriter", status: "idle", adapterType: "claude_local" },
  { id: "a-remote", name: "Gateway", title: null, status: "active", adapterType: "openclaw_gateway" },
  { id: "a-paused", name: "Sleeper", title: null, status: "paused", adapterType: "claude_local" },
  { id: "a-dead", name: "Gone", title: null, status: "terminated", adapterType: "hermes_local" },
  { id: "a-pending", name: "New", title: null, status: "pending_approval", adapterType: "claude_local" },
];

let workdir: string;
beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "studio-give-"));
  process.env.PIB_STUDIO_WORKDIR = workdir;
});
afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
  delete process.env.PIB_STUDIO_WORKDIR;
});

function world() {
  const created: Array<Record<string, unknown>> = [];
  const wakes: Array<{ issueId: string; options: Record<string, unknown> }> = [];
  const refuseWake = { on: false };
  const issues = new Map<string, Record<string, unknown>>();
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    agents: {
      list: async () => AGENTS,
      get: async (id: string) => AGENTS.find((a) => a.id === id) ?? null,
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        const issue = { ...input, id: `issue-${created.length}`, identifier: `PAR-${900 + created.length}`, originKind: "plugin:partnersinbiz.studio", status: "todo" };
        issues.set(issue.id, issue);
        return issue;
      },
      get: async (id: string) => issues.get(id) ?? null,
      requestWakeup: async (issueId: string, _co: string, options: Record<string, unknown>) => {
        if (refuseWake.on) throw new Error("Budget hard stop");
        wakes.push({ issueId, options });
        return { queued: true };
      },
    },
  } as unknown as PluginContext;
  return { ctx, created, wakes, refuseWake, issues };
}

function asset(over: Record<string, unknown> = {}) {
  return { id: ASSET, company_id: CO, client_kind: "company", client_ref: "acme", client_name: "Acme Ltd", project_id: "project-acme", name: "Hero shot", kind: "image", status: "approved", current_version: 2, r2_key: `studio/${CO}/company-acme/${ASSET}/v2.png`, mime: "image/png", bytes: 2048, ...over };
}

beforeEach(() => {
  state.row = asset();
  state.owner = { kind: "company", id: "acme", name: "Acme Ltd" };
  state.links = [];
  state.gets = 0;
});

describe("agent choices", () => {
  it("offers only agents that can run, and says why remote ones can't open files", async () => {
    const { ctx } = world();
    const list = await giveChoices(ctx, CO);
    expect(list.map((a) => a.id)).toEqual(["a-local", "a-remote"]);
    expect(list[0]).toMatchObject({ canOpen: true, why: null });
    expect(list[1]).toMatchObject({ canOpen: false });
    expect(list[1]!.why).toContain("runs off this server");
  });

  it("marks paused, terminated and pending agents as unable to run", () => {
    for (const a of AGENTS.slice(2)) expect(agentChoice(a)).toMatchObject({ canRun: false });
  });
});

describe("giveAsset", () => {
  it("opens an issue for the agent with the instruction as written, links it, wakes it, and copies the file", async () => {
    const w = world();
    const instruction = "  Write 3 captions.\n\nKeep them *short*.  ";
    const out = await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction }, EDITOR);
    expect(out).toMatchObject({ issueId: "issue-1", identifier: "PAR-901", agent: { id: "a-local", name: "Writer" }, woken: true });
    const input = w.created[0]!;
    expect(input).toMatchObject({ companyId: CO, projectId: "project-acme", assigneeAgentId: "a-local", status: "todo", originId: ASSET, actor: { actorUserId: "user-1" } });
    // Studio may only use its own origin kind: the host fills it in.
    expect(input.originKind).toBeUndefined();
    expect(String(input.description).startsWith(instruction)).toBe(true);
    expect(input.title).toBe("Studio: Write 3 captions.");
    expect(state.links).toEqual([{ assetId: ASSET, type: "issue", targetId: "issue-1" }]);
    expect(w.wakes).toEqual([{ issueId: "issue-1", options: expect.objectContaining({ idempotencyKey: "studio-give:issue-1", actorUserId: "user-1" }) }]);
    const path = /`([^`]+given[^`]+)`/.exec(String(input.description))![1]!;
    expect(path.startsWith(join(workdir, CO, GIVEN_DIR))).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No signed link or storage key goes to the agent.
    expect(String(input.description)).not.toContain("r2");
    expect(String(input.description)).not.toContain("studio/");
    expect(String(input.description)).not.toMatch(/https?:/);
  });

  it("refuses viewers in the worker", async () => {
    const w = world();
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "x" }, { userId: "v", role: "viewer" })).rejects.toThrow(/Viewers/);
    expect(w.created).toHaveLength(0);
  });

  it("refuses agents that can't run or can't open the file, and never makes an issue for them", async () => {
    const w = world();
    for (const agentId of ["a-paused", "a-dead", "a-pending"]) {
      await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId, instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "agent_cant_run" });
    }
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-remote", instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "agent_cant_open" });
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "nope", instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "unknown_agent" });
    expect(w.created).toHaveLength(0);
    expect(state.gets).toBe(0);
  });

  it("keeps a client's file on that client's work", async () => {
    const w = world();
    state.owner = { kind: "company", id: "globex", name: "Globex" };
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "wrong_client" });
    state.owner = null;
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "wrong_client" });
    state.row = asset({ client_kind: null, client_ref: null, client_name: null, project_id: "project-acme" });
    state.owner = { kind: "company", id: "acme", name: "Acme Ltd" };
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "x" }, EDITOR)).rejects.toMatchObject({ code: "wrong_client" });
    expect(w.created).toHaveLength(0);
  });

  it("lets own work with no project go to an agent", async () => {
    const w = world();
    state.row = asset({ client_kind: null, client_ref: null, client_name: null, project_id: null });
    state.owner = null;
    await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "Look" }, EDITOR);
    expect(w.created[0]).toMatchObject({ projectId: undefined });
    expect(String(w.created[0]!.description)).toContain("Client: Own work");
  });

  it("needs an instruction and caps its length", async () => {
    const w = world();
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "   " }, EDITOR)).rejects.toMatchObject({ code: "bad_give" });
    await expect(giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "x".repeat(10_001) }, EDITOR)).rejects.toMatchObject({ code: "bad_give" });
    expect(w.created).toHaveLength(0);
  });

  it("keeps the issue when the wake is refused, and says so", async () => {
    const w = world();
    w.refuseWake.on = true;
    const out = await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "Go" }, EDITOR);
    expect(out).toMatchObject({ woken: false, wakeError: expect.stringContaining("Budget") });
    expect(state.links).toHaveLength(1);
  });

  it("makes a separate copy for each give", async () => {
    const w = world();
    await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "One" }, EDITOR);
    await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "Two" }, EDITOR);
    const paths = w.created.map((c) => /`([^`]+given[^`]+)`/.exec(String(c.description))![1]);
    expect(new Set(paths).size).toBe(2);
  });
});

describe("given issues on the asset", () => {
  it("lists only Studio-made issues with this asset as origin, with the agent's name", async () => {
    const w = world();
    await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "Go" }, EDITOR);
    w.issues.set("issue-other", { id: "issue-other", identifier: "PAR-1", originKind: "manual", originId: ASSET });
    const list = await givenIssues(w.ctx, CO, ASSET, ["issue-1", "issue-other", "issue-missing"]);
    expect(list).toEqual([{ id: "issue-1", identifier: "PAR-901", title: "Studio: Go", status: "todo", agentName: "Writer" }]);
  });
});

describe("text", () => {
  it("titles from the first line of the instruction, or the file name", () => {
    expect(giveTitle("Hero", "a".repeat(200)).length).toBeLessThanOrEqual(8 + 80);
    expect(giveTitle("Hero", "\n\n")).toBe("Studio: Hero");
  });
  it("tells the agent the path and how long it's kept", () => {
    const d = giveDescription("Do it", { name: "Hero", mime: "image/png", bytes: 10, version: 1, assetId: ASSET, client: "Acme", path: "/x/y.png" });
    expect(d).toContain("`/x/y.png`");
    expect(d).toContain("14 days");
  });
});

describe("sweep", () => {
  it("keeps given copies for 14 days and tool copies for one", async () => {
    const w = world();
    await giveAsset(w.ctx, CO, { assetId: ASSET, agentId: "a-local", instruction: "Keep" }, EDITOR);
    const path = /`([^`]+given[^`]+)`/.exec(String(w.created[0]!.description))![1]!;
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(path, twoDaysAgo, twoDaysAgo);
    await sweepLocalCopies();
    expect(statSync(path).isFile()).toBe(true);
    await sweepLocalCopies(undefined, Date.now() + 15 * 86_400_000);
    expect(() => statSync(path)).toThrow();
  });
});
