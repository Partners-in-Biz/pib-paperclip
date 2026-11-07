import { describe, expect, it } from "vitest";
import { sprintDriveTarget } from "../src/service/drive-export.js";

describe("sprintDriveTarget (PAR-8128)", () => {
  it("a client sprint always carries its own client, even when the caller names another", () => {
    expect(sprintDriveTarget({ clientKind: "company", clientRef: "acme" })).toEqual({ client: { kind: "company", ref: "acme" } });
    expect(sprintDriveTarget({ clientKind: "company", clientRef: "acme" }, { kind: "contact", ref: "other" })).toEqual({ client: { kind: "company", ref: "acme" } });
  });

  it("an own sprint asks for the own folder explicitly", () => {
    expect(sprintDriveTarget({ clientKind: null, clientRef: null, legacyClientName: null })).toEqual({ ownWork: true });
  });

  it("an own sprint with a caller client uses that client", () => {
    expect(sprintDriveTarget({ clientKind: null, clientRef: null }, { kind: "contact", ref: "c-1" })).toEqual({ client: { kind: "contact", ref: "c-1" } });
  });

  it("an old sprint with only a free-text client name is not copied (could be anyone's)", () => {
    expect(sprintDriveTarget({ clientKind: null, clientRef: null, legacyClientName: "Acme Ltd" })).toBeNull();
  });
});
