import { describe, expect, it } from "vitest";
import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { experimentStatuses } from "../src/growth/service.js";
import { POST_STATUSES } from "../src/platforms.js";
import { connectInstructions, postParams, proposedTime } from "../src/service.js";
import { EXPERIMENT_STATUSES, OVERRIDES, SOCIAL_TOOLS } from "../src/tools.js";

type Schema = { type?: string; description?: string; enum?: unknown[]; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: unknown };

/** Every property (nested objects, array items, override entries) with its path. */
function properties(schema: Schema, path: string): Array<{ path: string; prop: Schema }> {
  const out: Array<{ path: string; prop: Schema }> = [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    out.push({ path: `${path}.${key}`, prop });
    out.push(...properties(prop, `${path}.${key}`));
    if (prop.items) out.push(...properties(prop.items, `${path}.${key}[]`));
    if (prop.additionalProperties && typeof prop.additionalProperties === "object") out.push(...properties(prop.additionalProperties as Schema, `${path}.${key}.*`));
  }
  return out;
}

const tool = (name: string) => SOCIAL_TOOLS.find((t) => t.name === name)!;

describe("tool surface", () => {
  it("every parameter has a description", () => {
    const missing = SOCIAL_TOOLS.flatMap((t) => properties(t.parametersSchema as Schema, t.name)).filter(({ prop }) => !prop.description?.trim()).map((p) => p.path);
    expect(missing).toEqual([]);
  });

  it("fixed values are enums", () => {
    const props = (name: string) => (tool(name).parametersSchema as Schema).properties!;
    expect(props("list-posts").status!.enum).toEqual([...POST_STATUSES]);
    expect(props("list-inbox").status!.enum).toEqual(["new", "read", "replied"]);
    expect(props("record-inbox-item").kind!.enum).toEqual(["comment", "mention", "message"]);
    expect(props("create-post").visibility!.enum).toEqual(["org", "personal"]);
    expect(props("create-media-asset").kind!.enum).toEqual(["image", "video"]);
    expect(props("connect-account").platform!.enum).toHaveLength(12);
    expect(props("list-experiments").status!.items!.enum).toEqual([...EXPERIMENT_STATUSES]);
  });

  it("create-post and update-post share one override schema, defined once", () => {
    const create = (tool("create-post").parametersSchema as Schema).properties!;
    const update = (tool("update-post").parametersSchema as Schema).properties!;
    expect(create.overrides).toBe(OVERRIDES);
    expect(update.overrides).toBe(OVERRIDES);
    // One entry schema for every platform instead of twelve copies.
    expect((OVERRIDES as Schema).properties).toBeUndefined();
    expect(typeof (OVERRIDES as Schema).additionalProperties).toBe("object");
    // Well under the ~1.1k tokens each used to cost (about 4 characters a token).
    expect(JSON.stringify(tool("create-post").parametersSchema).length).toBeLessThan(3200);
    expect(JSON.stringify(tool("update-post").parametersSchema).length).toBeLessThan(3200);
  });

  it("create-post takes client and visibility; the confusing scope param is gone", () => {
    const props = (tool("create-post").parametersSchema as Schema).properties!;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["client", "visibility", "scheduledAt"]));
    expect(props.scope).toBeUndefined();
    expect((tool("update-post").parametersSchema as Schema).properties!.scheduledAt).toBeDefined();
  });

  it("still accepts the old scope param: org/personal is the visibility, a client value is the client", () => {
    expect(postParams({ body: "x", scope: "personal" })).toMatchObject({ visibility: "personal" });
    expect(postParams({ body: "x", scope: "org", visibility: "personal" })).toMatchObject({ visibility: "personal" });
    expect(postParams({ body: "x", scope: "company:c1" })).toMatchObject({ client: "company:c1" });
    expect(postParams({ body: "x", scope: "own" })).toMatchObject({ client: "own" });
    expect(postParams({ body: "x", scope: "contact:k1", client: "company:c2" })).toMatchObject({ client: "company:c2" });
    expect(postParams({ body: "x" })).toEqual({ body: "x" });
  });

  it("reads a proposed time: ISO, cleared with an empty string, refused when malformed", () => {
    expect(proposedTime({})).toBeUndefined();
    expect(proposedTime({ scheduledAt: "" })).toBeNull();
    expect(proposedTime({ scheduledAt: null })).toBeNull();
    expect(proposedTime({ scheduledAt: "2026-10-05T07:30:00+02:00" })).toBe("2026-10-05T05:30:00.000Z");
    expect(() => proposedTime({ scheduledAt: "next monday" })).toThrow(/ISO date-time/);
  });

  it("experiment status filters take a list or the older comma text", () => {
    expect(experimentStatuses(["running", "proposed"])).toEqual(["running", "proposed"]);
    expect(experimentStatuses("running, measured")).toEqual(["running", "measured"]);
    expect(experimentStatuses(undefined)).toBeUndefined();
    expect(() => experimentStatuses(["done"])).toThrow(/Unknown experiment status/);
  });

  it("connect-account tells the agent to ask the owner once, with the deep link and steps", () => {
    const result = connectInstructions("linkedin", null, "/social?tab=accounts&client=company%3Ac1");
    expect(result.link).toBe("/social?tab=accounts&client=company%3Ac1");
    expect(result.steps[0]).toBe("Open /social?tab=accounts&client=company%3Ac1.");
    expect(result.instructions).toContain("partnersinbiz.cockpit:ask-owner");
    expect(result.instructions).not.toMatch(/Ask a person/);
  });

  it("the parameter JSON schemas stay plain objects (no host-specific keywords)", () => {
    for (const t of SOCIAL_TOOLS) {
      const json = JSON.stringify(t.parametersSchema as JsonSchema);
      expect(json, t.name).not.toContain("propertyNames");
      expect(json, t.name).not.toContain("$ref");
    }
  });
});
