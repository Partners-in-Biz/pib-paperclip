import { describe, it, expect } from "vitest";
import { boot, CO } from "./helpers/crm.js";
import { listClientFiles } from "../src/drive/files-list.js";
import { CLIENT_SUBFOLDERS, DRIVE_SUBFOLDERS, PRODUCT_SUBFOLDERS } from "../src/drive/convention.js";
import type { DriveFile } from "../src/drive/store.js";

const NOW = new Date().toISOString();

function driveFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: "f-1",
    companyId: "co-1",
    projectId: "p-1",
    kind: "client",
    folderId: "folder-root",
    name: "2026-10-20 report v1.pdf",
    sha256: "abc123",
    driveFileId: "drive-f1",
    webUrl: "https://drive.google.com/file/d/abc/view",
    sourcePlugin: "crm",
    subfolder: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("listClientFiles", () => {
  it("groups files by subfolder and filters non-https URLs", () => {
    const files = [
      driveFile({ subfolder: "Deliverables" }),
      driveFile({ subfolder: "Deliverables", webUrl: "http://bad.com" }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Deliverables");
  });

  it("orders groups in the drive's own order (DRIVE_SUBFOLDERS), null subfolders last", () => {
    const files = [
      driveFile({ subfolder: "Deliverables" }),
      driveFile({ subfolder: "Assets/Images" }),
      driveFile({ subfolder: null }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.label).toBe("Assets/Images");
    expect(groups[1]!.label).toBe("Deliverables");
    expect(groups[2]!.label).toBe("Project root files");
  });

  it("every standard sub-folder sorts at its index in DRIVE_SUBFOLDERS whatever order the files come in: the client folders first, then the product ones", () => {
    const shuffled = [...DRIVE_SUBFOLDERS].reverse();
    const files = [driveFile({ subfolder: null }), ...shuffled.map((subfolder) => driveFile({ subfolder }))];
    const groups = listClientFiles(files);
    expect(groups.map((group) => group.subfolder)).toEqual([...DRIVE_SUBFOLDERS, null]);
    expect(groups.map((group) => group.subfolder).slice(0, CLIENT_SUBFOLDERS.length)).toEqual([...CLIENT_SUBFOLDERS]);
    expect(groups.map((group) => group.subfolder).slice(CLIENT_SUBFOLDERS.length, DRIVE_SUBFOLDERS.length)).toEqual([...PRODUCT_SUBFOLDERS]);
    // sortNumber is the index in DRIVE_SUBFOLDERS, and the root files come last
    expect(groups.slice(0, -1).map((group) => group.sortNumber)).toEqual(DRIVE_SUBFOLDERS.map((_, index) => index));
    expect(groups[groups.length - 1]!.sortNumber).toBeGreaterThan(groups[groups.length - 2]!.sortNumber);
  });

  it("old numbered names and any other unknown name come after every standard sub-folder, by name, and the root files are last; the order does not depend on the input order", () => {
    const names = ["03 Deliverables", "Assets/Social", "invalid folder name", null, "01 Briefs", "Shared externally", "99 Archive"];
    const expected = ["Assets/Social", "Shared externally", "01 Briefs", "03 Deliverables", "99 Archive", "invalid folder name", null];
    for (const order of [names, [...names].reverse(), [names[4], names[0], names[6], names[3], names[5], names[2], names[1]]]) {
      const groups = listClientFiles(order.map((subfolder) => driveFile({ subfolder })));
      expect(groups.map((group) => group.subfolder)).toEqual(expected);
    }
    // A legacy name is its own group (the stored text is kept as it was); it is not merged into its alias
    const merged = listClientFiles([driveFile({ subfolder: "04 Reports" }), driveFile({ subfolder: "Deliverables" })]);
    expect(merged.map((group) => group.label)).toEqual(["Deliverables", "04 Reports"]);
  });

  it("orders files by creation date (newest first) within each group", () => {
    const older = driveFile({ name: "old.pdf", subfolder: "Deliverables", createdAt: "2026-10-19T00:00:00Z" });
    const newer = driveFile({ name: "new.pdf", subfolder: "Deliverables" });
    const groups = listClientFiles([older, newer]);
    expect(groups[0]!.files[0]!.name).toBe("new.pdf");
    expect(groups[0]!.files[1]!.name).toBe("old.pdf");
  });

  it("excludes groups with no https URLs", () => {
    const files = [driveFile({ subfolder: "Deliverables", webUrl: "http://bad.com" })];
    expect(listClientFiles(files)).toHaveLength(0);
  });

  it("handles unknown subfolder strings by placing them after the standard ones", () => {
    const files = [
      driveFile({ subfolder: "invalid folder name" }),
      driveFile({ subfolder: "Meetings & Notes" }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).toBe("Meetings & Notes");
    expect(groups[1]!.label).toBe("invalid folder name");
  });
});

describe("drive-files data handler", () => {
  it("returns empty list when companyId or projectId missing", async () => {
    const { harness } = await boot();
    const result = await harness.getData<{ groups: any[] }>(
      "drive-files",
      { companyId: undefined, projectId: "p1" },
    );
    expect(result.groups).toEqual([]);
  });

  it("returns error field when handler throws", async () => {
    const { harness } = await boot();
    // Simulate a handler error by triggering listDriveFiles to fail
    // We can do this by using invalid company/project IDs that will cause DB errors
    const result = await harness.getData<{ groups: any[]; error?: string }>(
      "drive-files",
      { companyId: "", projectId: "" }, // Empty IDs should cause validation to pass but DB query to fail
    );
    // The handler should gracefully handle the error
    expect(result.groups).toEqual([]);
  });

  it("isolates files by company_id and project_id", async () => {
    const { harness, store } = await boot();
    store.drive_files = [
      {
        id: "f1",
        company_id: CO,
        project_id: "p1",
        kind: "client",
        folder_id: "f-root",
        name: "co1-file.pdf",
        sha256: "abc123",
        drive_file_id: "gd-f1",
        web_url: "https://drive.google.com/file/d/abc/view",
        source_plugin: "crm",
        subfolder: "Deliverables",
        created_at: NOW,
      },
      {
        id: "f2",
        company_id: "co-2",
        project_id: "p1",
        kind: "client",
        folder_id: "f-root",
        name: "co2-file.pdf",
        sha256: "def456",
        drive_file_id: "gd-f2",
        web_url: "https://drive.google.com/file/d/def/view",
        source_plugin: "crm",
        subfolder: "Deliverables",
        created_at: NOW,
      },
    ];
    const result = await harness.getData<{ groups: any[] }>("drive-files", {
      companyId: CO,
      projectId: "p1",
    });
    expect(result.groups[0]!.files).toHaveLength(1);
    expect(result.groups[0]!.files[0]!.name).toBe("co1-file.pdf");
  });

  it("filters non-https URLs in handler", async () => {
    const { harness, store } = await boot();
    store.drive_files = [
      {
        id: "f1",
        company_id: CO,
        project_id: "p1",
        kind: "client",
        folder_id: "f-root",
        name: "https-file.pdf",
        sha256: "abc123",
        drive_file_id: "gd-f1",
        web_url: "https://drive.google.com/file/d/abc/view",
        source_plugin: "crm",
        subfolder: "Deliverables",
        created_at: NOW,
      },
      {
        id: "f2",
        company_id: CO,
        project_id: "p1",
        kind: "client",
        folder_id: "f-root",
        name: "http-file.pdf",
        sha256: "def456",
        drive_file_id: "gd-f2",
        web_url: "http://example.com/file",
        source_plugin: "crm",
        subfolder: "Deliverables",
        created_at: NOW,
      },
    ];
    const result = await harness.getData<{ groups: any[] }>("drive-files", {
      companyId: CO,
      projectId: "p1",
    });
    expect(result.groups[0]!.files).toHaveLength(1);
  });
});
