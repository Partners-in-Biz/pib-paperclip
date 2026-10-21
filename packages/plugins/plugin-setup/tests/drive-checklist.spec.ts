import { describe, it, expect } from "vitest";
import { driveChecklist, parseDriveBindingEvent, type DriveBinding } from "../src/drive-checklist.js";

describe("parseDriveBindingEvent", () => {
  it("returns null for invalid payloads", () => {
    expect(parseDriveBindingEvent(null)).toBeNull();
    expect(parseDriveBindingEvent(undefined)).toBeNull();
    expect(parseDriveBindingEvent("string")).toBeNull();
    expect(parseDriveBindingEvent({})).toBeNull(); // missing companyId
  });

  it("parses valid minimal payload", () => {
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: false,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [],
    });
    expect(result).toEqual({
      companyId: "comp-1",
      connected: false,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [],
    });
  });

  it("parses full payload with email and drive ID", () => {
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: true,
      bound: true,
      sharedDriveId: "drive-123",
      serviceAccountEmail: "sa@example.com",
      serviceAccountIsMember: true,
      candidates: [{ id: "drive-123", name: "Company Drive" }],
    });
    expect(result?.connected).toBe(true);
    expect(result?.bound).toBe(true);
    expect(result?.sharedDriveId).toBe("drive-123");
    expect(result?.serviceAccountEmail).toBe("sa@example.com");
    expect(result?.serviceAccountIsMember).toBe(true);
  });

  it("caps candidates at 50", () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `drive-${i}`,
      name: `Drive ${i}`,
    }));
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: false,
      bound: false,
      serviceAccountIsMember: false,
      candidates,
    });
    expect(result?.candidates.length).toBe(50);
  });

  it("trims candidate names to 200 chars", () => {
    const longName = "x".repeat(300);
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: false,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [{ id: "drive-1", name: longName }],
    });
    expect(result?.candidates[0].name.length).toBe(200);
  });

  it("filters out invalid candidate entries", () => {
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: false,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [
        { id: "drive-1", name: "Valid" },
        { id: "", name: "No ID" },
        { id: "drive-2", name: "" },
        null as unknown as Record<string, unknown>,
        { name: "No ID field" },
      ],
    });
    expect(result?.candidates).toEqual([{ id: "drive-1", name: "Valid" }]);
  });

  it("drops extra keys like token or secret", () => {
    const result = parseDriveBindingEvent({
      companyId: "comp-1",
      connected: true,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [],
      token: "secret-token",
      tokenSet: { access_token: "xyz" },
      extraField: "should be dropped",
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("tokenSet");
    expect(result).not.toHaveProperty("extraField");
    expect(result?.companyId).toBe("comp-1");
  });
});

describe("driveChecklist", () => {
  it("returns two items for null drive", () => {
    const items = driveChecklist(null);
    expect(items).toHaveLength(2);
    expect(items[0].key).toBe("drive-connect");
    expect(items[1].key).toBe("drive-member");
  });

  it("marks connect item done when drive connected", () => {
    const drive: DriveBinding = {
      companyId: "comp-1",
      connected: true,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [],
    };
    const items = driveChecklist(drive);
    expect(items[0].status).toBe("done");
    expect(items[1].status).toBe("failed");
  });

  it("marks member item done when service account is member", () => {
    const drive: DriveBinding = {
      companyId: "comp-1",
      connected: true,
      bound: true,
      serviceAccountEmail: "sa@example.com",
      serviceAccountIsMember: true,
      candidates: [],
    };
    const items = driveChecklist(drive);
    expect(items[0].status).toBe("done");
    expect(items[1].status).toBe("done");
  });

  it("includes email in member item label and detail when present", () => {
    const drive: DriveBinding = {
      companyId: "comp-1",
      connected: true,
      bound: false,
      serviceAccountEmail: "service@example.com",
      serviceAccountIsMember: false,
      candidates: [],
    };
    const items = driveChecklist(drive);
    expect(items[1].label).toContain("service@example.com");
    expect(items[1].detail).toBe("service@example.com");
  });

  it("uses placeholder text when no email", () => {
    const drive: DriveBinding = {
      companyId: "comp-1",
      connected: true,
      bound: false,
      serviceAccountIsMember: false,
      candidates: [],
    };
    const items = driveChecklist(drive);
    expect(items[1].label).toBe("Add the Drive service account to the company's Shared Drive");
    expect(items[1].detail).toBeUndefined();
  });

  it("always returns items with status failed when drive is null", () => {
    const items = driveChecklist(null);
    expect(items[0].status).toBe("failed");
    expect(items[1].status).toBe("failed");
  });
});
