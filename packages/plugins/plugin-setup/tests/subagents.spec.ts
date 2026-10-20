import { describe, expect, it } from "vitest";
import { parseSubagents, subagentExtraArgs, subagentsText } from "../src/subagents.js";

describe("parseSubagents", () => {
  it("returns undefined when raw is undefined", () => {
    expect(parseSubagents(undefined, "test")).toBeUndefined();
  });

  it("parses a valid empty policy", () => {
    const result = parseSubagents({ allowed: [], model: "", maxParallel: 0 }, "test");
    expect(result).toEqual({ allowed: [], model: "", maxParallel: 0 });
  });

  it("parses a valid non-empty policy", () => {
    const result = parseSubagents({ allowed: ["explorer", "test-runner"], model: "claude-sonnet-5-5", maxParallel: 2 }, "test");
    expect(result).toEqual({ allowed: ["explorer", "test-runner"], model: "claude-sonnet-5-5", maxParallel: 2 });
  });

  it("throws when allowed is not an array", () => {
    expect(() => parseSubagents({ allowed: "explorer", model: "haiku", maxParallel: 1 }, "where")).toThrow("where: subagents.allowed must be an array");
  });

  it("throws when allowed contains non-string values", () => {
    expect(() => parseSubagents({ allowed: ["explorer", 123], model: "haiku", maxParallel: 1 }, "where")).toThrow("where: subagents.allowed must be an array of non-empty strings");
  });

  it("throws when allowed contains empty strings", () => {
    expect(() => parseSubagents({ allowed: ["explorer", ""], model: "haiku", maxParallel: 1 }, "where")).toThrow("where: subagents.allowed must be an array of non-empty strings");
  });

  it("throws when allowed has duplicates", () => {
    expect(() => parseSubagents({ allowed: ["explorer", "explorer"], model: "haiku", maxParallel: 1 }, "where")).toThrow("where: subagents.allowed has duplicates");
  });

  it("throws when model is not a string", () => {
    expect(() => parseSubagents({ allowed: ["explorer"], model: 123, maxParallel: 1 }, "where")).toThrow("where: subagents.model must be a string");
  });

  it("throws when model is empty but allowed is non-empty", () => {
    expect(() => parseSubagents({ allowed: ["explorer"], model: "", maxParallel: 1 }, "where")).toThrow("where: subagents.model must be non-empty when subagents.allowed is non-empty");
  });

  it("throws when maxParallel is not an integer", () => {
    expect(() => parseSubagents({ allowed: [], model: "", maxParallel: 1.5 }, "where")).toThrow("where: subagents.maxParallel must be an integer");
  });

  it("throws when maxParallel is negative", () => {
    expect(() => parseSubagents({ allowed: [], model: "", maxParallel: -1 }, "where")).toThrow("where: subagents.maxParallel must be >= 0");
  });

  it("throws when maxParallel is non-zero but allowed is empty", () => {
    expect(() => parseSubagents({ allowed: [], model: "", maxParallel: 1 }, "where")).toThrow("where: subagents.maxParallel must be 0 when subagents.allowed is empty");
  });
});

describe("subagentExtraArgs", () => {
  it("returns empty array for undefined policy", () => {
    expect(subagentExtraArgs(undefined)).toEqual([]);
  });

  it("returns disallowed tools for empty allowed list", () => {
    expect(subagentExtraArgs({ allowed: [], model: "", maxParallel: 0 })).toEqual(["--disallowedTools", "Task,Agent"]);
  });

  it("returns allowed tools for non-empty allowed list (single)", () => {
    const args = subagentExtraArgs({ allowed: ["explorer"], model: "haiku", maxParallel: 1 });
    expect(args[0]).toBe("--allowedTools");
    expect(args[1]).toContain("Task(explorer)");
    expect(args[1]).toContain("Agent(explorer)");
  });

  it("returns allowed tools for non-empty allowed list (multiple)", () => {
    const args = subagentExtraArgs({ allowed: ["explorer", "test-runner"], model: "haiku", maxParallel: 2 });
    expect(args[0]).toBe("--allowedTools");
    const toolsList = args[1]!;
    expect(toolsList).toContain("Task(explorer)");
    expect(toolsList).toContain("Task(test-runner)");
    expect(toolsList).toContain("Agent(explorer)");
    expect(toolsList).toContain("Agent(test-runner)");
  });

  it("includes all names exactly once in order (Tasks then Agents)", () => {
    const args = subagentExtraArgs({ allowed: ["a", "b", "c"], model: "haiku", maxParallel: 3 });
    const toolsList = args[1]!;
    // Should be: Task(a),Task(b),Task(c),Agent(a),Agent(b),Agent(c)
    const expected = "Task(a),Task(b),Task(c),Agent(a),Agent(b),Agent(c)";
    expect(toolsList).toBe(expected);
  });
});

describe("subagentsText", () => {
  it("returns no-spawn text for undefined policy", () => {
    expect(subagentsText(undefined)).toBe("You do not spawn subagents. Do the work yourself.");
  });

  it("returns no-spawn text for empty allowed list", () => {
    expect(subagentsText({ allowed: [], model: "", maxParallel: 0 })).toBe("You do not spawn subagents. Do the work yourself.");
  });

  it("returns prose for non-empty policy", () => {
    const text = subagentsText({ allowed: ["explorer"], model: "haiku", maxParallel: 1 });
    expect(text).toContain("You may spawn these subagents");
    expect(text).toContain("model haiku");
    expect(text).toContain("explorer");
    expect(text).toContain("Run at most 1 at once");
  });

  it("lists all names joined by commas", () => {
    const text = subagentsText({ allowed: ["explorer", "test-runner", "reviewer"], model: "claude-sonnet-5-5", maxParallel: 2 });
    expect(text).toContain("explorer, test-runner, reviewer");
  });

  it("includes the maxParallel value", () => {
    const text = subagentsText({ allowed: ["explorer"], model: "haiku", maxParallel: 3 });
    expect(text).toContain("Run at most 3 at once");
  });
});
