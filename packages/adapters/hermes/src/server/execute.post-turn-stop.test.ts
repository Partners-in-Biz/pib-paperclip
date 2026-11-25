/**
 * PAR-13539: a Hermes run whose agent has finished but whose background jobs
 * keep the `hermes chat -Q` process alive (exit linger + notification
 * follow-up turns) must end shortly after the turn, not at timeoutSec.
 *
 * Runs a real child process: a fake `hermes` that writes its turn report the
 * way Hermes does, starts a detached background job in its own session (like
 * a Vite dev server), and then lingers.
 */

import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execute } from "./execute.js";

const LINUX = process.platform === "linux";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function fakeHermes(body: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hermes-post-turn-"));
  dirs.push(dir);
  const bin = path.join(dir, "hermes");
  await fsp.writeFile(bin, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return { dir, bin, bgPidFile: path.join(dir, "bg.pid") };
}

function makeCtx(command: string, home: string, config: Record<string, unknown> = {}) {
  return {
    runId: `run-post-turn-${Math.random().toString(36).slice(2)}`,
    agent: { id: "agent-1", companyId: "company-1", name: "Hermes", adapterType: "hermes_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command, timeoutSec: 60, graceSec: 1, env: { HERMES_HOME: home }, ...config },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async (_stream: string, _chunk: string) => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Writes the report atomically like Hermes' write_turn_report, then starts a
// background job that outlives the turn and lingers on it.
const LINGERING_HERMES = (bgPidFile: string) => `
echo '{"type":"system","subtype":"init","session_id":"20261119_101500_abc123"}'
printf '{"pid": %d, "exit_code": 0, "error": "", "reply": "Handoff: the work is done."}' $$ > "$HERMES_QUIET_TURN_REPORT_FILE.tmp"
mv "$HERMES_QUIET_TURN_REPORT_FILE.tmp" "$HERMES_QUIET_TURN_REPORT_FILE"
setsid bash -c 'trap "" TERM; echo $$ > "${bgPidFile}"; while true; do sleep 1; done' </dev/null >/dev/null 2>&1 &
trap '' TERM
while true; do sleep 1; done
`;

describe.skipIf(!LINUX || spawnSync("setsid", ["--version"]).status !== 0)("hermes post-turn stop", () => {
  it("ends a lingering run shortly after its final turn and stops its background job", async () => {
    const fake = await fakeHermes(LINGERING_HERMES("__BG__"));
    await fsp.writeFile(fake.bin, (await fsp.readFile(fake.bin, "utf8")).replace("__BG__", fake.bgPidFile));
    const ctx = makeCtx(fake.bin, fake.dir, { postTurnExitGraceSec: 1 });

    const started = Date.now();
    const result = await execute(ctx as never);
    const elapsedMs = Date.now() - started;

    // Grace (1 s) + SIGTERM ignored + SIGKILL after graceSec (1 s): far below timeoutSec (60 s).
    expect(elapsedMs).toBeLessThan(15_000);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.errorMessage).toBeUndefined();
    expect(result.summary).toBe("Handoff: the work is done.");
    expect(result.resultJson).toMatchObject({ postTurnStop: { reason: "hermes_post_turn_linger", forceKilled: true } });
    // The session_id line is printed only at exit; the run keeps its session from the init event.
    expect(result.sessionParams).toMatchObject({ sessionId: "20261119_101500_abc123" });

    const bgPid = Number((await fsp.readFile(fake.bgPidFile, "utf8")).trim());
    await vi.waitFor(() => expect(alive(bgPid)).toBe(false), { timeout: 5000, interval: 50 });

    const logs = ctx.onLog.mock.calls.map((call) => String(call[1])).join("");
    expect(logs).toContain("stopping it and 1 background process group(s)");
  }, 30_000);

  it("does not touch a run that exits by itself after its report", async () => {
    const fake = await fakeHermes(`
printf '{"pid": %d, "exit_code": 0, "error": "", "reply": "ok"}' $$ > "$HERMES_QUIET_TURN_REPORT_FILE"
echo "ok"
echo
echo "session_id: 20261119_120000_abcd"
`);
    const ctx = makeCtx(fake.bin, fake.dir, { postTurnExitGraceSec: 5 });
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).not.toHaveProperty("postTurnStop");
    expect(result.summary).toBe("ok");
  }, 30_000);

  it("leaves the old behaviour when postTurnExitGraceSec is 0", async () => {
    const fake = await fakeHermes(`
if [ -n "$HERMES_QUIET_TURN_REPORT_FILE" ]; then echo "report=set"; else echo "report=unset"; fi
`);
    const ctx = makeCtx(fake.bin, fake.dir, { postTurnExitGraceSec: 0 });
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(String(result.resultJson?.result ?? "")).toContain("report=unset");
  }, 30_000);
});
