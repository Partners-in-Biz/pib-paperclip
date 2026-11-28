import { describe, expect, it } from "vitest";
import { draftOf, draftProblem, managersLine, parseMembers, personLabel, setManagersParams } from "../src/ui/managed-by-view.js";

const names = new Map([["peet", "Peet"], ["jan", "Jan"]]);
const data = (over: Partial<Parameters<typeof managersLine>[0]> = {}) => ({ ownerUserId: "peet", managerUserIds: ["jan"], canChange: false, you: null, ...over });

describe("Managed by card", () => {
  it("names the owner and managers, says You for the reader, and a neutral word when names cannot be read", () => {
    expect(managersLine(data(), names)).toBe("Peet (owner), Jan");
    expect(managersLine(data({ you: "jan" }), names)).toBe("Peet (owner), You");
    expect(managersLine(data({ managerUserIds: ["kim"] }), new Map())).toBe("A team member (owner), A team member");
    expect(managersLine(data({ ownerUserId: null, managerUserIds: [] }), names)).toBe("Nobody yet");
    expect(personLabel("jan", { you: "jan" }, names)).toBe("You");
  });

  it("a draft needs an owner, no one twice, at most three more; the owner and blanks are dropped from the list sent", () => {
    expect(draftOf(data({ ownerUserId: null }))).toEqual({ ownerUserId: "", managerUserIds: ["jan"] });
    expect(draftProblem({ ownerUserId: "", managerUserIds: [] })).toBe("Pick an owner");
    expect(draftProblem({ ownerUserId: "peet", managerUserIds: ["jan", "jan"] })).toBe("A person is on the list twice");
    expect(draftProblem({ ownerUserId: "peet", managerUserIds: ["a", "b", "c", "d"] })).toBe("At most 3 managers beside the owner");
    expect(draftProblem({ ownerUserId: "peet", managerUserIds: ["peet", "jan", ""] })).toBeNull();
    expect(setManagersParams("acme", { ownerUserId: "peet", managerUserIds: ["peet", "jan", ""] })).toEqual({ companyRecordId: "acme", ownerUserId: "peet", managerUserIds: ["jan"] });
  });

  it("reads active people from the members route, by name, else email, else id", () => {
    expect(parseMembers({ members: [
      { principalType: "user", principalId: "u2", status: "active", user: { name: "Zed" } },
      { principalType: "user", principalId: "u1", status: "active", user: { name: " ", email: "amy@x.test" } },
      { principalType: "user", principalId: "u3", status: "suspended", user: { name: "Gone" } },
      { principalType: "agent", principalId: "a1", status: "active" },
      null,
    ] })).toEqual([{ userId: "u1", label: "amy@x.test" }, { userId: "u2", label: "Zed" }]);
    expect(parseMembers({ error: "Forbidden" })).toBeNull();
  });
});
