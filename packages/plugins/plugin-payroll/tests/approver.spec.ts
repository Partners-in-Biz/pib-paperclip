/**
 * "Who approves pay runs": people by name (never ids), the preparer rule,
 * and saving only `approval.defaultApproverUserId` while keeping every other
 * saved setting, secret refs included.
 */
import { describe, expect, it } from "vitest";
import {
  approverName,
  approverOptions,
  approverWarning,
  parseUserDirectory,
  personName,
  saveErrorText,
  withDefaultApprover,
} from "../src/ui/approver.js";

const DIRECTORY = {
  users: [
    { principalId: "u-owner", status: "active", user: { id: "u-owner", name: "Peet Stander", email: "peet@example.test" } },
    { principalId: "u-finance", status: "active", user: { id: "u-finance", name: null, email: "finance@example.test" } },
    { principalId: "u-ghost", status: "active", user: null },
    { principalId: "u-gone", status: "suspended", user: { id: "u-gone", name: "Gone", email: "gone@example.test" } },
    { principalId: "u-owner", status: "active", user: { id: "u-owner", name: "Peet again", email: null } },
    { status: "active", user: { id: "no-principal", name: "No id" } },
    "junk",
  ],
};

describe("the user directory", () => {
  it("keeps active people once each, with their name and email", () => {
    expect(parseUserDirectory(DIRECTORY)).toEqual([
      { userId: "u-owner", name: "Peet Stander", email: "peet@example.test" },
      { userId: "u-finance", name: null, email: "finance@example.test" },
      { userId: "u-ghost", name: null, email: null },
    ]);
    for (const body of [null, {}, { users: "x" }, []]) expect(parseUserDirectory(body)).toEqual([]);
  });

  it("names a person by name, else email, never by id", () => {
    expect(personName({ name: " Peet ", email: "p@x.test" })).toBe("Peet");
    expect(personName({ name: null, email: "finance@example.test" })).toBe("finance@example.test");
    expect(personName({ name: null, email: null }, true)).toBe("You");
    expect(personName(null)).toBe("A board member");
  });
});

describe("approver options", () => {
  const people = parseUserDirectory(DIRECTORY);
  const runs = [
    { preparedBy: { kind: "user", id: "u-finance" } },
    { preparedBy: { kind: "user", id: "u-finance" } },
    { preparedBy: { kind: "agent", id: "u-owner" } },
    { preparedBy: null },
  ];

  it("lists people by name with the email as detail, counting runs each prepared", () => {
    const options = approverOptions(people, { me: "u-owner", runs });
    expect(options).toEqual([
      { userId: "u-ghost", name: "A board member", detail: null, isYou: false, preparedRuns: 0 },
      { userId: "u-finance", name: "finance@example.test", detail: null, isYou: false, preparedRuns: 2 },
      { userId: "u-owner", name: "Peet Stander", detail: "peet@example.test", isYou: true, preparedRuns: 0 },
    ]);
    // No option shows a raw id.
    for (const option of options) expect(`${option.name} ${option.detail ?? ""}`).not.toMatch(/u-(owner|finance|ghost)/);
  });

  it("warns when the chosen person prepares pay runs", () => {
    const options = approverOptions(people, { me: "u-finance", runs });
    const finance = options.find((o) => o.userId === "u-finance")!;
    expect(approverWarning(finance)).toBe("You prepared 2 recent pay runs, so you can't approve those. Let the Payroll Clerk or someone else prepare the runs.");
    expect(approverWarning({ name: "Thandi", isYou: false, preparedRuns: 1 })).toBe("Thandi prepared 1 recent pay run, so they can't approve it. Let the Payroll Clerk or someone else prepare the runs.");
    expect(approverWarning(options.find((o) => o.userId === "u-owner"))).toBeNull();
    expect(approverWarning(null)).toBeNull();
  });

  it("names the current approver, or says they are gone", () => {
    expect(approverName("u-owner", people, null)).toBe("Peet Stander");
    expect(approverName("u-owner", people, "u-owner")).toBe("Peet Stander");
    expect(approverName("u-left", people, null)).toBe("someone who is no longer a member");
    expect(approverName("u-left", null, null)).toBe("the person chosen in the settings");
    expect(approverName("u-me", null, "u-me")).toBe("you");
    expect(approverName("u-ghost", people, "u-ghost")).toBe("you");
    expect(approverName(null, people, null)).toBeNull();
  });
});

describe("saving the approver", () => {
  const SAVED = {
    employer: { legalName: "Partners in Biz (Pty) Ltd", payeReference: "7123456789" },
    encryptionKey: { type: "secret_ref", secretId: "11111111-2222-3333-4444-555555555555" },
    r2: { accountId: "acc", bucket: "private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "66666666-7777-8888-9999-000000000000", version: "latest" } },
    approval: { defaultApproverUserId: "u-old", leaveApproverUserId: "u-leave", lockOnApproval: false },
    sdlMode: "registered",
    defaultPayDay: 25,
  };

  it("changes only approval.defaultApproverUserId and keeps every other key", () => {
    const before = JSON.parse(JSON.stringify(SAVED));
    const next = withDefaultApprover(SAVED, "u-owner");
    expect(next).toEqual({ ...SAVED, approval: { defaultApproverUserId: "u-owner", leaveApproverUserId: "u-leave", lockOnApproval: false } });
    expect(next.encryptionKey).toEqual(SAVED.encryptionKey);
    expect((next.r2 as { secretAccessKey: unknown }).secretAccessKey).toEqual(SAVED.r2.secretAccessKey);
    // The saved object is not changed.
    expect(SAVED).toEqual(before);
  });

  it("works on settings that were never saved, and can clear the approver", () => {
    expect(withDefaultApprover({}, "u-owner")).toEqual({ approval: { defaultApproverUserId: "u-owner" } });
    expect(withDefaultApprover(SAVED, null).approval).toEqual({ leaveApproverUserId: "u-leave", lockOnApproval: false });
    expect(withDefaultApprover({ approval: "junk" }, "u-owner")).toEqual({ approval: { defaultApproverUserId: "u-owner" } });
  });

  it("explains a refused save in one plain sentence", () => {
    expect(saveErrorText(403)).toBe("Only an instance admin can change this setting.");
    expect(saveErrorText(401)).toBe("Only an instance admin can change this setting.");
    expect(saveErrorText(400)).toMatch(/settings page/);
    expect(saveErrorText(500)).toBe("Couldn't save the approver. Try again.");
  });
});
