import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CHILD_SLICE_ENV,
  resetAgentChildSliceProbeCacheForTests,
  resolveAgentChildSliceName,
  resolveUsableAgentChildSlice,
  wrapCommandStringInSlice,
  wrapSpawnInSlice,
} from "./agent-child-slice.js";

const SLICE = "pib-agent-devtools.slice";

afterEach(() => {
  resetAgentChildSliceProbeCacheForTests();
  vi.restoreAllMocks();
});

describe("agent child slice", () => {
  it("is off when the env var is unset or blank", async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveUsableAgentChildSlice({}, probe)).toBeNull();
    expect(await resolveUsableAgentChildSlice({ [AGENT_CHILD_SLICE_ENV]: "  " }, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects names that are not a systemd slice", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveAgentChildSliceName({ [AGENT_CHILD_SLICE_ENV]: "foo; rm -rf /" })).toBeNull();
    expect(resolveAgentChildSliceName({ [AGENT_CHILD_SLICE_ENV]: "paperclip.service" })).toBeNull();
    expect(resolveAgentChildSliceName({ [AGENT_CHILD_SLICE_ENV]: SLICE })).toBe(SLICE);
  });

  it("uses the slice only when the probe passes, and probes once", async () => {
    const env = { [AGENT_CHILD_SLICE_ENV]: SLICE };
    const ok = vi.fn(async () => true);
    expect(await resolveUsableAgentChildSlice(env, ok)).toBe(SLICE);
    expect(await resolveUsableAgentChildSlice(env, ok)).toBe(SLICE);
    expect(ok).toHaveBeenCalledTimes(1);

    resetAgentChildSliceProbeCacheForTests();
    const denied = vi.fn(async () => false);
    expect(await resolveUsableAgentChildSlice(env, denied)).toBeNull();
    const throws = vi.fn(async () => {
      throw new Error("boom");
    });
    resetAgentChildSliceProbeCacheForTests();
    expect(await resolveUsableAgentChildSlice(env, throws)).toBeNull();
  });

  it("wraps argv and command strings in a systemd-run scope", () => {
    expect(wrapSpawnInSlice(SLICE, "/usr/bin/node", ["a.js", "--x"])).toEqual({
      command: "systemd-run",
      args: ["--scope", "--quiet", "--collect", `--slice=${SLICE}`, "--", "/usr/bin/node", "a.js", "--x"],
    });
    expect(wrapCommandStringInSlice(SLICE, '"/usr/bin/claude" --acp')).toBe(
      `systemd-run --scope --quiet --collect --slice=${SLICE} -- "/usr/bin/claude" --acp`,
    );
  });
});
