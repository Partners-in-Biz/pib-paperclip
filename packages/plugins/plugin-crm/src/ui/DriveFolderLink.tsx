import type { CSSProperties } from "react";

export interface DriveFolderLinkProps {
  folder: { name: string; url: string } | null;
}

/**
 * Renders a link to a Drive folder when available, otherwise renders nothing.
 * The folder name wraps cleanly without overflow even in constrained space.
 */
export function DriveFolderLink({ folder }: DriveFolderLinkProps) {
  if (!folder) return null;

  // Validate URL is http(s)
  try {
    const url = new URL(folder.url);
    if (!url.protocol.match(/^https?:/)) return null;
  } catch {
    return null;
  }

  const linkStyle: CSSProperties = {
    minWidth: 0,
    overflowWrap: "anywhere",
    flexWrap: "wrap",
  };

  return (
    <a href={folder.url} target="_blank" rel="noopener noreferrer" title={folder.name} style={linkStyle}>
      Drive folder: {folder.name}
    </a>
  );
}
