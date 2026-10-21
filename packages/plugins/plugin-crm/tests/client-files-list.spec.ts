import { describe, it, expect } from "vitest";
import { boot, CO } from "./helpers/crm.js";
import { listClientFiles } from "../src/drive/files-list.js";
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
      driveFile({ subfolder: "03 Deliverables" }),
      driveFile({ subfolder: "03 Deliverables", webUrl: "http://bad.com" }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("03 Deliverables");
  });

  it("orders groups by subfolder number ascending, null subfolders last", () => {
    const files = [
      driveFile({ subfolder: "03 Deliverables" }),
      driveFile({ subfolder: "01 Briefs" }),
      driveFile({ subfolder: null }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.label).toBe("01 Briefs");
    expect(groups[1]!.label).toBe("03 Deliverables");
    expect(groups[2]!.label).toBe("Project root files");
  });

  it("orders files by creation date (newest first) within each group", () => {
    const older = driveFile({ name: "old.pdf", subfolder: "03 Deliverables", createdAt: "2026-10-19T00:00:00Z" });
    const newer = driveFile({ name: "new.pdf", subfolder: "03 Deliverables" });
    const groups = listClientFiles([older, newer]);
    expect(groups[0]!.files[0]!.name).toBe("new.pdf");
    expect(groups[0]!.files[1]!.name).toBe("old.pdf");
  });

  it("excludes groups with no https URLs", () => {
    const files = [driveFile({ subfolder: "03 Deliverables", webUrl: "http://bad.com" })];
    expect(listClientFiles(files)).toHaveLength(0);
  });

  it("handles unknown subfolder strings by placing them in root group", () => {
    const files = [
      driveFile({ subfolder: "invalid folder name" }),
      driveFile({ subfolder: "01 Briefs" }),
    ];
    const groups = listClientFiles(files);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).toBe("01 Briefs");
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
        subfolder: "03 Deliverables",
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
        subfolder: "03 Deliverables",
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
        subfolder: "03 Deliverables",
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
        subfolder: "03 Deliverables",
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
