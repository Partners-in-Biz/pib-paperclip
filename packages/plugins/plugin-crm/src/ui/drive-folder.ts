/**
 * Pure logic for Drive folder link generation.
 * No React dependency—only data transformations and validation.
 */

export interface Folder {
  name: string;
  url: string;
}

export interface DriveFolderLinkData {
  href: string;
  text: string;
}

/**
 * Validates and builds a Drive folder link data object.
 * Returns null if the folder is invalid, URL is unsafe, or folder is null.
 * Returns an object with href and text (link text depends on whether label is provided).
 */
export function buildDriveFolderLink(
  folder: Folder | null,
  label?: string
): DriveFolderLinkData | null {
  if (!folder) return null;

  // Validate URL is http(s)
  try {
    const url = new URL(folder.url);
    if (!url.protocol.match(/^https?:/)) return null;
  } catch {
    return null;
  }

  // When a label is provided, render only the folder name as link text
  // (the label cell displays "Drive folder" as the field label)
  const text = label ? folder.name : `Drive folder: ${folder.name}`;

  return {
    href: folder.url,
    text,
  };
}
