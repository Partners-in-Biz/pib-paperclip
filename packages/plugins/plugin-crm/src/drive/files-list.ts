/**
 * Pure function to list client project files grouped by subfolder.
 * No database context or side effects. Groups drive files by subfolder value.
 */
import type { DriveFile } from "./store.js";

export interface ClientFile {
  name: string;
  createdAt: string;
  sourcePlugin: string | null;
  url: string;
}

export interface FileGroup {
  subfolder: string | null;
  label: string;
  sortNumber: number; // For ordering: 1-5, 99, or 999 for root files
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
 * Extract the leading number from a subfolder name (e.g. "03 Deliverables" -> 3).
 * Returns 999 for null/unknown subfolders, indicating they should appear last.
 */
function getSortNumber(subfolder: string | null): number {
  if (!subfolder) return 999;
  const match = subfolder.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 999;
}

/**
 * List and group drive files by subfolder. Files are ordered by creation date
 * (newest first) within each group. Files are grouped by their saved subfolder
 * value (e.g. "03 Deliverables"). Files with null/unknown subfolder are grouped
 * in "Project root files" and appear last.
 *
 * Files with non-https URLs are filtered out and not returned.
 *
 * @param files - Array of drive files from the database
 * @returns Array of grouped and sorted FileGroup objects
 */
export function listClientFiles(files: DriveFile[]): FileGroup[] {
  const bySubfolder = new Map<string | null, DriveFile[]>();
  for (const file of files) {
    const key = file.subfolder ?? null;
    if (!bySubfolder.has(key)) {
      bySubfolder.set(key, []);
    }
    bySubfolder.get(key)!.push(file);
  }

  const groups: FileGroup[] = [];
  for (const [subfolder, subfolderFiles] of bySubfolder.entries()) {
    const clientFiles = mapToClientFiles(subfolderFiles);
    if (clientFiles.length > 0) {
      const sortNumber = getSortNumber(subfolder);
      const label = subfolder || "Project root files";
      groups.push({
        subfolder,
        label,
        sortNumber,
        files: clientFiles.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      });
    }
  }

  return groups.sort((a, b) => a.sortNumber - b.sortNumber || a.label.localeCompare(b.label));
}
