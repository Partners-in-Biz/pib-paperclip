/**
 * Display files saved to a Paperclip project's Drive folder.
 * Renders grouped files with name, date, source, and https-validated links.
 */
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { tokens, formatDate } from "@partnersinbiz/pib-plugin-ui";
import type { FileGroup, ClientFile } from "../drive/files-list.js";

interface FileGroupResponse {
  groups: FileGroup[];
  error?: string;
}

export interface DriveFilesProps {
  projectId: string | null;
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
          color: tokens.primary,
          textDecoration: "none",
          minWidth: 0,
          flex: "1 1 auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {file.name}
      </a>
      <div
        style={{
          display: "flex",
          gap: "12px",
          color: tokens.muted,
          fontSize: "12px",
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        <span>{formatDate(file.createdAt)}</span>
        {file.sourcePlugin && (
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {file.sourcePlugin}
          </span>
        )}
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
          color: tokens.fg,
        }}
      >
        {group.label}
      </h3>
      <div
        style={{
          display: "grid",
          gap: "0",
          borderLeft: `1px solid ${tokens.border}`,
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
 * Display all saved Drive files for a project, grouped by subfolder.
 * Shows an empty state when no files are available, or an error state on failure.
 */
export function DriveFiles({ projectId }: DriveFilesProps) {
  const hostContext = useHostContext();
  const driveFilesData = usePluginData<FileGroupResponse>("drive-files", {
    companyId: hostContext.companyId ?? undefined,
    projectId: projectId ?? undefined,
  });

  const groups = driveFilesData.data?.groups ?? [];
  const payloadError = driveFilesData.data?.error;
  const transportError = typeof driveFilesData.error === "string" ? driveFilesData.error : undefined;
  const errorMessage = transportError || payloadError;

  return (
    <div style={{ marginTop: "16px" }}>
      <h2 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 12px 0" }}>
        Saved files
      </h2>
      {errorMessage ? (
        <p style={{ fontSize: "13px", color: tokens.muted, margin: 0 }}>
          {errorMessage}
        </p>
      ) : groups.length === 0 ? (
        <p style={{ fontSize: "13px", color: tokens.muted, margin: 0 }}>No files saved yet.</p>
      ) : (
        groups.map((group) => (
          <FileGroupSection key={group.subfolder ?? "root"} group={group} />
        ))
      )}
    </div>
  );
}
