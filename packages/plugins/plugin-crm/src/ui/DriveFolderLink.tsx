import type { CSSProperties } from "react";

export interface DriveFolderLinkProps {
  folder: { name: string; url: string } | null;
  label?: string;
}

/**
 * Renders a link to a Drive folder when available, otherwise renders nothing.
 * The folder name wraps cleanly without overflow even in constrained space.
 * When `label` is provided, it is used as the field label (in the UI layout),
 * so the link text contains only the folder name.
 */
export function DriveFolderLink({ folder, label }: DriveFolderLinkProps) {
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

  // When a label is provided, render only the folder name as link text
  // (the label cell displays "Drive folder" as the field label)
  const linkText = label ? folder.name : `Drive folder: ${folder.name}`;

  return (
    <a href={folder.url} target="_blank" rel="noopener noreferrer" title={folder.name} style={linkStyle}>
      {linkText}
    </a>
  );
}
