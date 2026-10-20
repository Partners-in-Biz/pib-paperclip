/**
 * Pure function to list client project files grouped by folder.
 * No database context or side effects. Groups drive files by folder_id.
 */
import type { DriveFile } from "./store.js";

export interface ClientFile {
  name: string;
  createdAt: string;
  sourcePlugin: string | null;
  url: string;
}

export interface FileGroup {
  folderId: string;
  label: string;
  sortNumber: number; // For ordering: 1-5, 99, or 999 for unmapped
  files: ClientFile[];
}

/**
 * Validates that a URL is https. Returns true if valid, false otherwise.
 */
function isHttpsUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === "https:";
  } catch {
    return false;
  }
}


/**
 * Convert raw drive files to a list of ClientFile records, filtering out
 * files with non-https URLs.
 */
function mapToClientFiles(files: DriveFile[]): ClientFile[] {
  return files
    .filter((f) => isHttpsUrl(f.webUrl))
    .map((f) => ({
      name: f.name,
      createdAt: f.createdAt,
      sourcePlugin: f.sourcePlugin,
      url: f.webUrl,
    }));
}

/**
 * List and group drive files by folder. Files are ordered by creation date
 * (newest first) within each group. Currently, most files are saved to the
 * project root folder, so typically one group labeled "Other files".
 *
 * Files with non-https URLs are filtered out and not returned.
 *
 * @param files - Array of drive files from the database
 * @returns Array of grouped and sorted FileGroup objects
 */
export function listClientFiles(files: DriveFile[]): FileGroup[] {
  const byFolder = new Map<string, DriveFile[]>();
  for (const file of files) {
    if (!byFolder.has(file.folderId)) {
      byFolder.set(file.folderId, []);
    }
    byFolder.get(file.folderId)!.push(file);
  }

  const groups: FileGroup[] = [];
  for (const [folderId, folderFiles] of byFolder.entries()) {
    const clientFiles = mapToClientFiles(folderFiles);
    if (clientFiles.length > 0) {
      groups.push({
        folderId,
        label: "Other files",
        sortNumber: 999,
        files: clientFiles.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      });
    }
  }

  return groups.sort((a, b) => a.sortNumber - b.sortNumber || a.label.localeCompare(b.label));
}
