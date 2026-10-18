import { describe, it, expect } from "vitest";
import { DriveFolderLink } from "../src/ui/DriveFolderLink.js";

/**
 * Unit tests for DriveFolderLink component.
 * Tests the component rendering and URL validation behavior.
 */
describe("DriveFolderLink", () => {
  it("returns null when folder is null", () => {
    const result = DriveFolderLink({ folder: null });
    expect(result).toBe(null);
  });

  it("returns a React element with valid https URL", () => {
    const result = DriveFolderLink({
      folder: { name: "Acme Brief", url: "https://drive.google.com/drive/folders/abc123" },
    });
    expect(result).not.toBeNull();
    expect(result).toBeDefined();
    expect(result!.type).toBe("a");
  });

  it("renders anchor with correct href attribute", () => {
    const testUrl = "https://drive.google.com/drive/folders/xyz789";
    const result = DriveFolderLink({
      folder: { name: "Test Folder", url: testUrl },
    });
    expect(result).not.toBeNull();
    expect(result?.props.href).toBe(testUrl);
  });

  it("renders anchor with correct rel attribute", () => {
    const result = DriveFolderLink({
      folder: { name: "Test Folder", url: "https://example.com/folder" },
    });
    expect(result?.props.rel).toBe("noopener noreferrer");
  });

  it("includes folder name in rendered text content without label", () => {
    const folderName = "Acme Brief";
    const result = DriveFolderLink({
      folder: { name: folderName, url: "https://example.com/folder" },
    });
    // Check that the folder name is present in the children with "Drive folder: " prefix
    expect(result?.props.children).toContain("Drive folder:");
    expect(result?.props.children).toContain(folderName);
  });

  it("renders only folder name when label is provided", () => {
    const folderName = "Acme Brief";
    const result = DriveFolderLink({
      folder: { name: folderName, url: "https://example.com/folder" },
      label: "Drive folder",
    });
    // Check that only the folder name is rendered, without the "Drive folder: " prefix
    expect(result?.props.children).toBe(folderName);
  });

  it("returns null for non-https URL (javascript protocol)", () => {
    const result = DriveFolderLink({
      folder: { name: "Bad", url: "javascript:alert('xss')" },
    });
    expect(result).toBe(null);
  });

  it("returns null for ftp:// URL", () => {
    const result = DriveFolderLink({
      folder: { name: "Bad", url: "ftp://example.com/folder" },
    });
    expect(result).toBe(null);
  });

  it("returns null for file:// URL", () => {
    const result = DriveFolderLink({
      folder: { name: "Bad", url: "file:///path/to/file" },
    });
    expect(result).toBe(null);
  });

  it("returns null for invalid URL", () => {
    const result = DriveFolderLink({
      folder: { name: "Bad", url: "not a url at all" },
    });
    expect(result).toBe(null);
  });

  it("renders with http:// URL", () => {
    const result = DriveFolderLink({
      folder: { name: "Test", url: "http://example.com/folder" },
    });
    expect(result).not.toBeNull();
    expect(result?.type).toBe("a");
    expect(result?.props.href).toBe("http://example.com/folder");
  });

  it("renders with special characters in folder name", () => {
    const folderName = 'Folder & < > "';
    const result = DriveFolderLink({
      folder: { name: folderName, url: "https://example.com/folder" },
    });
    expect(result).not.toBeNull();
    expect(result?.props.children).toContain(folderName);
  });

  it("opens link in new tab with target='_blank'", () => {
    const result = DriveFolderLink({
      folder: { name: "Test", url: "https://example.com/folder" },
    });
    expect(result?.props.target).toBe("_blank");
  });
});
