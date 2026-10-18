import type { CSSProperties } from "react";
import { buildDriveFolderLink, type Folder } from "./drive-folder.js";

export interface DriveFolderLinkProps {
  folder: Folder | null;
  label?: string;
}

/**
 * Renders a link to a Drive folder when available, otherwise renders nothing.
 * The folder name wraps cleanly without overflow even in constrained space.
 * When `label` is provided, it is used as the field label (in the UI layout),
 * so the link text contains only the folder name.
 */
export function DriveFolderLink({ folder, label }: DriveFolderLinkProps) {
  const linkData = buildDriveFolderLink(folder, label);
  if (!linkData) return null;

  const linkStyle: CSSProperties = {
    minWidth: 0,
    overflowWrap: "anywhere",
    flexWrap: "wrap",
  };

  return (
    <a href={linkData.href} target="_blank" rel="noopener noreferrer" title={folder!.name} style={linkStyle}>
      {linkData.text}
    </a>
  );
}
