import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StudioError } from "../src/errors.js";
import { guardAction, isRefusal, StudioRefusalError, unwrapAction } from "../src/refusal.js";
import { makerLabel, parseDirectory } from "../src/ui/people.js";

const DRIVE_REASON = "This client has no Drive project in CRM yet. Set drive.ownProjectId in the CRM settings.";

describe("page action refusals (PAR-8120)", () => {
  it("answers a StudioError as { ok: false, message } instead of throwing", async () => {
    const action = guardAction(async () => {
      throw new StudioError(DRIVE_REASON, "drive_refused");
    });
    const out = await action({}, {});
    expect(out).toEqual({ ok: false, refused: true, code: "drive_refused", message: DRIVE_REASON });
    expect(isRefusal(out)).toBe(true);
  });

  it("keeps throwing genuine faults", async () => {
    const action = guardAction(async () => {
      throw new Error("connection reset");
    });
    await expect(action({}, {})).rejects.toThrow("connection reset");
  });

  it("passes normal answers through, including ones with ok: false but no refusal mark", async () => {
    expect(await guardAction(async () => ({ saved: true }))({}, {})).toEqual({ saved: true });
    const plain = { ok: false, status: "pending" };
    expect(isRefusal(plain)).toBe(false);
    expect(unwrapAction(plain)).toBe(plain);
  });

  it("the page turns the refusal back into an Error with the real reason", async () => {
    const out = await guardAction(async () => {
      throw new StudioError(DRIVE_REASON, "drive_refused");
    })({}, {});
    expect(() => unwrapAction(out)).toThrow(StudioRefusalError);
    expect(() => unwrapAction(out)).toThrow(DRIVE_REASON);
  });

  it("every worker action goes through the guard, and every page uses the unwrapping hook", () => {
    const src = join(__dirname, "../src");
    const worker = readFileSync(join(src, "worker.ts"), "utf8");
    expect(worker).not.toMatch(/ctx\.actions\.register\(/);
    for (const key of ["drive-save", "drive-list", "drive-import", "give-prepare", "give-record", "give-discard", "review", "generate", "estimate"]) {
      expect(worker).toContain(`action("${key}"`);
    }
    const ui = join(src, "ui");
    for (const file of readdirSync(ui).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      if (file === "action.ts") continue;
      expect(readFileSync(join(ui, file), "utf8"), file).not.toMatch(/usePluginAction\(/);
    }
  });
});

describe("Made by shows the person's name (PAR-8120)", () => {
  const names = parseDirectory({
    users: [
      { principalId: "BjxhmUDC-user", status: "active", user: { id: "BjxhmUDC-user", name: "Peet Stander", email: "peet@example.com" } },
      { principalId: "u2", status: "active", user: { id: "u2", name: "  ", email: "two@example.com" } },
      { principalId: "u3", status: "active", user: null },
    ],
  });

  it("uses the name, then the email, never the id", () => {
    expect(makerLabel({ agentId: null, userId: "BjxhmUDC-user" }, names)).toBe("Peet Stander");
    expect(makerLabel({ agentId: null, userId: "u2" }, names)).toBe("two@example.com");
    expect(makerLabel({ agentId: null, userId: "u3" }, names)).toBe("A person");
    expect(makerLabel({ agentId: null, userId: "gone" }, new Map())).toBe("A person");
  });

  it("agents and unknowns keep their labels", () => {
    expect(makerLabel({ agentId: "012aeb07-c18c", userId: null }, names)).toBe("Agent 012aeb07");
    expect(makerLabel(null, names)).toBe("Unknown");
    expect(parseDirectory(null).size).toBe(0);
  });
});
