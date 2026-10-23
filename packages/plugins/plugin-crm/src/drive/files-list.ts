/**
 * Pure function to list client project files grouped by subfolder.
 * No database context or side effects. Groups drive files by subfolder value.
 */
import type { DriveFile } from "./store.js";
import { DRIVE_SUBFOLDERS } from "./convention.js";

export interface ClientFile {
  name: string;
  createdAt: string;
  sourcePlugin: string | null;
  url: string;
}

export interface FileGroup {
  subfolder: string | null;
  label: string;
  sortNumber: number; // For ordering: the index in DRIVE_SUBFOLDERS, UNKNOWN_SORT for a name not in it (old numbered names too), ROOT_SORT for root files
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

const UNKNOWN_SORT = 100;
const ROOT_SORT = 999;

/**
 * The position of a subfolder in the drive's own order (DRIVE_SUBFOLDERS: the client folders first, then the product ones).
 * A name that is not in it (an old numbered name such as "03 Deliverables", or anything else) sorts after all of those,
 * and the root files (no subfolder) sort last.
 */
function getSortNumber(subfolder: string | null): number {
  if (!subfolder) return ROOT_SORT;
  const index = (DRIVE_SUBFOLDERS as readonly string[]).indexOf(subfolder);
  return index === -1 ? UNKNOWN_SORT : index;
}

/**
 * List and group drive files by subfolder. Files are ordered by creation date
 * (newest first) within each group. Files are grouped by their saved subfolder
 * value (e.g. "Deliverables") and the groups follow the order of DRIVE_SUBFOLDERS.
 * Groups whose name is not in it (old numbered names, anything else) come after those,
 * by name; files with no subfolder are grouped in "Project root files" and appear last.
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
