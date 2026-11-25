import { describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  isSafeSshDestinationPart,
  parseSshRemoteExecutionSpec,
  runSshCommand,
  sshDestination,
} from "./ssh.js";

const baseSpec = {
  host: "build.example.com",
  port: 22,
  username: "deploy",
  remoteCwd: "/srv/work",
};

describe("parseSshRemoteExecutionSpec destination guard", () => {
  it("parses a normal host and username", () => {
    const spec = parseSshRemoteExecutionSpec(baseSpec);
    expect(spec).not.toBeNull();
    expect(spec?.host).toBe("build.example.com");
    expect(spec?.username).toBe("deploy");
  });

  it("accepts IP hosts and usernames with dots, dashes and underscores inside", () => {
    expect(parseSshRemoteExecutionSpec({ ...baseSpec, host: "10.0.0.5", username: "ci-runner.bot_1" })).not.toBeNull();
    expect(parseSshRemoteExecutionSpec({ ...baseSpec, host: "::1" })).not.toBeNull();
  });

  it.each([
    ["host", "-oProxyCommand=x"],
    ["host", "  -oProxyCommand=touch /tmp/pwned"],
    ["username", "-x"],
    ["username", "-oProxyCommand=x"],
    ["host", "build example.com"],
    ["username", "dep\tloy"],
    ["host", "build.example.com\n-oProxyCommand=x"],
    ["username", "a\u0000b"],
    ["username", "root@evil"],
    ["host", "evil@build.example.com"],
  ])("returns null for %s %j", (field, value) => {
    expect(parseSshRemoteExecutionSpec({ ...baseSpec, [field]: value })).toBeNull();
  });
});

describe("sshDestination", () => {
  it("joins a safe username and host", () => {
    expect(sshDestination("deploy", "build.example.com")).toBe("deploy@build.example.com");
  });

  it("throws on a leading dash in either half", () => {
    expect(() => sshDestination("-oProxyCommand=x", "host")).toThrow(/Invalid SSH username/);
    expect(() => sshDestination("deploy", "-oProxyCommand=x")).toThrow(/Invalid SSH host/);
  });

  it("isSafeSshDestinationPart rejects empty, dash, whitespace, control chars and '@'", () => {
    for (const bad of ["", "-x", "a b", "a\nb", "a\u007fb", "a@b"]) {
      expect(isSafeSshDestinationPart(bad)).toBe(false);
    }
    expect(isSafeSshDestinationPart("build-01.example.com")).toBe(true);
  });
});

describe("ssh argv never receives an option-shaped destination", () => {
  it("buildSshSpawnTarget puts user@host after -p and rejects a dash username", async () => {
    const spec = parseSshRemoteExecutionSpec(baseSpec)!;
    const target = await buildSshSpawnTarget({ spec, command: "true", args: [], env: {} });
    try {
      const pIndex = target.args.indexOf("-p");
      expect(target.args[pIndex + 2]).toBe("deploy@build.example.com");
    } finally {
      await target.cleanup();
    }

    await expect(
      buildSshSpawnTarget({ spec: { ...spec, username: "-oProxyCommand=x" }, command: "true", args: [], env: {} }),
    ).rejects.toThrow(/Invalid SSH username/);
  });

  it("runSshCommand rejects a dash host from an unparsed config before spawning ssh", async () => {
    await expect(
      runSshCommand(
        {
          host: "-oProxyCommand=x",
          port: 22,
          username: "deploy",
          remoteWorkspacePath: "/srv/work",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        "true",
      ),
    ).rejects.toThrow(/Invalid SSH host/);
  });
});
