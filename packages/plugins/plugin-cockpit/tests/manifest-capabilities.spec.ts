/**
 * Manifest capabilities test: verifies that every ctx method used by
 * ladder.ts, watch.ts and the pib-plugin-kit escalate function is covered
 * by the manifest's declared capabilities.
 */

import { describe, it, expect } from "vitest";
import manifest from "../src/manifest.js";
import type { PluginCapability } from "@paperclipai/plugin-sdk";

/**
 * Maps ctx methods to their required capabilities.
 * This is derived from server/src/services/plugin-capability-validator.ts
 * and must be kept in sync with it.
 */
const USED_METHODS_TO_CAPABILITIES: Record<string, PluginCapability[]> = {
  // ladder.ts / escalate / watch.ts - state operations
  "ctx.state.get": ["plugin.state.read"],
  "ctx.state.set": ["plugin.state.write"],

  // ladder.ts / escalate - issue read operations
  "ctx.issues.get": ["issues.read"],
  "ctx.issues.listComments": ["issue.comments.read"],
  "ctx.issues.relations.get": ["issue.relations.read"],

  // ladder.ts / escalate - issue write operations
  "ctx.issues.create": ["issues.create"],
  "ctx.issues.update": ["issues.update"],
  "ctx.issues.createComment": ["issue.comments.create"],
  "ctx.issues.requestWakeup": ["issues.wakeup"],

  // escalate - agent operations
  "ctx.agents.get": ["agents.read"],

  // watch.ts - database operations
  "ctx.db.query": ["database.namespace.read"],
};

describe("Cockpit manifest capabilities", () => {
  it("should declare all capabilities required by ladder.ts, watch.ts and escalate", () => {
    const manifestCapabilities = new Set(manifest.capabilities);

    const missing: string[] = [];

    for (const [method, requiredCaps] of Object.entries(USED_METHODS_TO_CAPABILITIES)) {
      for (const cap of requiredCaps) {
        if (!manifestCapabilities.has(cap)) {
          missing.push(`${method} requires ${cap}`);
        }
      }
    }

    expect(missing, `Missing capabilities:\n${missing.join("\n")}`).toEqual([]);
  });
});
