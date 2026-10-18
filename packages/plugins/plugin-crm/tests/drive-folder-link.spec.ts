import { describe, it, expect } from "vitest";
import { buildDriveFolderLink } from "../src/ui/drive-folder.js";

/**
 * Unit tests for buildDriveFolderLink helper.
 * Tests URL validation and link data generation logic.
 */
describe("buildDriveFolderLink", () => {
  it("returns null when folder is null", () => {
    const result = buildDriveFolderLink(null);
    expect(result).toBe(null);
  });

  it("returns link data with valid https URL", () => {
    const result = buildDriveFolderLink({
      name: "Acme Brief",
      url: "https://drive.google.com/drive/folders/abc123",
    });
    expect(result).not.toBeNull();
    expect(result?.href).toBe("https://drive.google.com/drive/folders/abc123");
  });

  it("returns correct href attribute", () => {
    const testUrl = "https://drive.google.com/drive/folders/xyz789";
    const result = buildDriveFolderLink({
      name: "Test Folder",
      url: testUrl,
    });
    expect(result).not.toBeNull();
    expect(result?.href).toBe(testUrl);
  });

  it("includes folder name in text without label", () => {
    const folderName = "Acme Brief";
    const result = buildDriveFolderLink({
      name: folderName,
      url: "https://example.com/folder",
    });
    expect(result?.text).toBe(`Drive folder: ${folderName}`);
  });

  it("returns only folder name in text when label is provided", () => {
    const folderName = "Acme Brief";
    const result = buildDriveFolderLink(
      {
        name: folderName,
        url: "https://example.com/folder",
      },
      "Drive folder"
    );
    expect(result?.text).toBe(folderName);
  });

  it("returns null for non-https URL (javascript protocol)", () => {
    const result = buildDriveFolderLink({
      name: "Bad",
      url: "javascript:alert('xss')",
    });
    expect(result).toBe(null);
  });

  it("returns null for ftp:// URL", () => {
    const result = buildDriveFolderLink({
      name: "Bad",
      url: "ftp://example.com/folder",
    });
    expect(result).toBe(null);
  });

  it("returns null for file:// URL", () => {
    const result = buildDriveFolderLink({
      name: "Bad",
      url: "file:///path/to/file",
    });
    expect(result).toBe(null);
  });

  it("returns null for invalid URL", () => {
    const result = buildDriveFolderLink({
      name: "Bad",
      url: "not a url at all",
    });
    expect(result).toBe(null);
  });

  it("returns link data with http:// URL", () => {
    const result = buildDriveFolderLink({
      name: "Test",
      url: "http://example.com/folder",
    });
    expect(result).not.toBeNull();
    expect(result?.href).toBe("http://example.com/folder");
  });

  it("preserves special characters in folder name", () => {
    const folderName = 'Folder & < > "';
    const result = buildDriveFolderLink({
      name: folderName,
      url: "https://example.com/folder",
    });
    expect(result?.text).toContain(folderName);
  });
});
