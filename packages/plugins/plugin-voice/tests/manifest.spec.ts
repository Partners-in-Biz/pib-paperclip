import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("manifest", () => {
  it("matches package.json and declares only what it uses", () => {
    expect(manifest.version).toBe(pkg.version);
    // A3 (PAR-12643): access.members.read and the events pair for the access guard and its grant receiver.
    expect(manifest.capabilities).toEqual([
      "access.members.read",
      "agents.read",
      "events.subscribe",
      "events.emit",
      "http.outbound",
      "plugin.state.read",
      "plugin.state.write",
      "secrets.read-ref",
      "ui.action.register",
    ]);
  });

  it("mounts once in the app shell", () => {
    expect(manifest.ui?.slots).toEqual([expect.objectContaining({ type: "appShellOverlay", exportName: "VoiceOverlay" })]);
  });

  it("keeps the xAI key a secret ref", () => {
    const props = (manifest.instanceConfigSchema as { properties: Record<string, { format?: string }> }).properties;
    expect(props.xaiApiKey!.format).toBe("secret-ref");
  });
});
