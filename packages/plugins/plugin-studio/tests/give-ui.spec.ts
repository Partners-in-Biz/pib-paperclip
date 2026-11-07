import { describe, expect, it, vi } from "vitest";
import { popupDefaults, withDiscard } from "../src/ui/give-popup.js";

describe("Give to agent popup wrapper", () => {
  it("prefills title, description and project; leaves the project out for own work", () => {
    expect(popupDefaults({ giveId: "g", title: "T", description: "D", projectId: "p" })).toEqual({ title: "T", description: "D", projectId: "p" });
    expect(popupDefaults({ giveId: "g", title: "T", description: "D", projectId: null })).toEqual({ title: "T", description: "D" });
  });

  it("removes the copy when the popup closes without a task, or fails", async () => {
    const discard = vi.fn(async () => ({ removed: 1 }));
    await expect(withDiscard({ open: async () => null }, () => "g1", discard).open({})).resolves.toBeNull();
    expect(discard).toHaveBeenCalledWith("g1");
    await expect(withDiscard({ open: async () => { throw new Error("boom"); } }, () => "g2", discard).open({})).rejects.toThrow("boom");
    expect(discard).toHaveBeenLastCalledWith("g2");
  });

  it("keeps the copy when a task was created", async () => {
    const discard = vi.fn(async () => ({ removed: 1 }));
    const issue = { id: "i", identifier: "PAR-1", title: "T", projectId: null, assigneeAgentId: null };
    await expect(withDiscard({ open: async () => issue }, () => "g", discard).open({})).resolves.toBe(issue);
    expect(discard).not.toHaveBeenCalled();
  });
});
