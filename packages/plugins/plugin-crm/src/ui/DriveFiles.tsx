/**
 * Display files saved to a Paperclip project's Drive folder.
 * Renders grouped files with name, date, source, and https-validated links.
 */
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import type { FileGroup, ClientFile } from "../drive/files-list.js";

interface FileGroupResponse {
  groups: FileGroup[];
}

export interface DriveFilesProps {
  projectId: string | null;
}

/**
 * Format a date string for display (e.g., "Oct 20, 2026").
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso.split("T")[0] || iso;
  }
}

/**
 * Render a single file row within a group.
 */
function FileRow({ file }: { file: ClientFile }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "8px",
        padding: "8px 0",
        fontSize: "13px",
        alignItems: "flex-start",
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <a
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        title={file.name}
        style={{
          color: "#0066cc",
          textDecoration: "none",
          minWidth: 0,
          flex: "1 1 auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          wordBreak: "break-word",
        }}
      >
        {file.name}
      </a>
      <div
        style={{
          display: "flex",
          gap: "12px",
          color: "#666",
          fontSize: "12px",
          whiteSpace: "nowrap",
        }}
      >
        <span>{formatDate(file.createdAt)}</span>
        {file.sourcePlugin && <span>{file.sourcePlugin}</span>}
      </div>
    </div>
  );
}

/**
 * Render a group of files under a folder label.
 */
function FileGroupSection({ group }: { group: FileGroup }) {
  return (
    <div style={{ marginBottom: "16px" }}>
      <h3
        style={{
          margin: "0 0 8px 0",
          fontSize: "13px",
          fontWeight: 600,
          color: "#333",
        }}
      >
        {group.label}
      </h3>
      <div
        style={{
          display: "grid",
          gap: "0",
          borderLeft: "1px solid #ddd",
          paddingLeft: "12px",
        }}
      >
        {group.files.map((file) => (
          <FileRow key={file.url || file.name} file={file} />
        ))}
      </div>
    </div>
  );
}

/**
 * Display all saved Drive files for a project, grouped by folder.
 * Shows an empty state when no files are available.
 */
export function DriveFiles({ projectId }: DriveFilesProps) {
  const hostContext = useHostContext();
  const driveFilesData = usePluginData<FileGroupResponse>("drive-files", {
    companyId: hostContext.companyId ?? undefined,
    projectId: projectId ?? undefined,
  });

  const groups = driveFilesData.data?.groups ?? [];

  return (
    <div style={{ marginTop: "16px" }}>
      <h2 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 12px 0" }}>
        Saved files
      </h2>
      {groups.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#666", margin: 0 }}>No files saved yet.</p>
      ) : (
        groups.map((group) => (
          <FileGroupSection key={group.folderId} group={group} />
        ))
      )}
    </div>
  );
}
