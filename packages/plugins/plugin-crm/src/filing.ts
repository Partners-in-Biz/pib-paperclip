/**
 * Drive filing for signed documents: when an e-sign document is fully signed,
 * open a filing issue for the Account Manager to save the signed copy to Drive
 * in the client's Contracts & Quotes folder.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientProjectOf } from "./care-clients.js";
import { isCanaryId } from "./canary-flag.js";
import type { ReportRecord } from "./care-store.js";
import { periodLabel } from "./report-render.js";
import { openIssueOnce } from "./mail.js";
import { originFor } from "./origins.js";
import type { SignDocument } from "./esign-store.js";
import { teamAssignee } from "./routing.js";

const SIGNED_COPY_TO_FILE_KEY = "signed-copy-to-file";
const REPORT_TO_FILE_KEY = "report-to-file";

export { REPORT_TO_FILE_KEY, SIGNED_COPY_TO_FILE_KEY };

/**
 * Open a filing issue for the Account Manager when a signed copy exists.
 * Skips canary clients. Deduped by originId so running twice yields one issue.
 * Writes the signed markdown to the issue document for the Account Manager to file.
 */
export async function openSignedCopyFilingIssue(
  ctx: PluginContext,
  doc: SignDocument,
  clientName: string,
): Promise<void> {
  // Skip canary clients (their documents are dry runs).
  if (isCanaryId(doc.clientRef)) return;

  // Skip if there is no signed copy markdown.
  if (!doc.signedCopyMd) return;

  // The client key for project lookup.
  const client = { kind: doc.clientKind, id: doc.clientRef };

  // Generate the file name: YYYY-MM-DD <Client Name> <Document Title> signed v01.md
  // Extract the date from signedAt (ISO format: 2026-10-20T...).
  const dateStr = doc.signedAt?.slice(0, 10) ?? "unknown-date";

  // Sanitize the title: remove slashes and backslashes (potential path separators).
  const safeTitle = doc.title.replace(/[/\\]/g, "");

  const fileName = `${dateStr} ${clientName} ${safeTitle} signed v01.md`;

  // Open the issue using openIssueOnce for deduplication by origin.
  const issueId = await openIssueOnce(ctx, {
    companyId: doc.companyId,
    originId: originFor.driveFileEsign(doc.id),
    title: `File signed copy: ${doc.title} (${clientName})`.slice(0, 200),
    description: [
      `Save the signed copy of "${doc.title}" to Drive for ${clientName}.`,
      "",
      "**Where to save it:**",
      "- Folder: `Clients/<Company> (<Contact>)/Contracts & Quotes/`",
      "- File name: `" + fileName + "`",
      "",
      "**What to do:**",
      `Use the \`pib-drive-saving\` skill to upload the signed text to the folder above. The signed document is on this issue (document key \`${SIGNED_COPY_TO_FILE_KEY}\`).`,
      "",
      "See the skill for Drive naming and folder rules (FILEMAP.md in the Drive).",
    ].join("\n"),
    assignee: await teamAssignee(ctx, doc.companyId, "account-manager"),
    wakeReason: "A signed copy needs to be saved to Drive",
    projectId: await clientProjectOf(ctx, doc.companyId, client),
  });

  // Write the signed copy markdown to the issue document so the Account Manager can read it.
  await ctx.issues.documents.upsert({
    issueId,
    companyId: doc.companyId,
    key: SIGNED_COPY_TO_FILE_KEY,
    title: `Signed copy of ${doc.title}`,
    format: "markdown",
    body: doc.signedCopyMd,
    changeSummary: "Signed document for filing",
  });
}

/**
 * Open a filing issue for the Account Manager when a monthly report was really sent.
 * Callers skip dry runs; canary clients are skipped here. Deduped by report id.
 */
export async function openReportFilingIssue(ctx: PluginContext, record: ReportRecord, clientName: string): Promise<void> {
  if (isCanaryId(record.client.id) || !record.markdown) return;
  const label = periodLabel(record.period);
  const safeName = clientName.replace(/[/\\]/g, "");
  const fileName = `${record.period}-01 ${safeName} monthly report ${record.period} v01.md`;
  const issueId = await openIssueOnce(ctx, {
    companyId: record.companyId,
    originId: originFor.driveFileReport(record.id),
    title: `File monthly report: ${label} (${clientName})`.slice(0, 200),
    description: [
      `Save the ${label} report for ${clientName} to Drive. It was sent to the client.`,
      "",
      "**Where to save it:**",
      "- Folder: `Clients/<Company> (<Contact>)/Deliverables/`",
      "- File name: `" + fileName + "`",
      "",
      "**What to do:**",
      `Use the \`pib-drive-saving\` skill to upload the report text to the folder above. The report is on this issue (document key \`${REPORT_TO_FILE_KEY}\`).`,
      "",
      "See the skill for Drive naming and folder rules (FILEMAP.md in the Drive).",
    ].join("\n"),
    assignee: await teamAssignee(ctx, record.companyId, "account-manager"),
    wakeReason: "A sent report needs to be saved to Drive",
    projectId: await clientProjectOf(ctx, record.companyId, record.client),
  });
  await ctx.issues.documents.upsert({
    issueId,
    companyId: record.companyId,
    key: REPORT_TO_FILE_KEY,
    title: `${label} report for ${clientName}`,
    format: "markdown",
    body: record.markdown,
    changeSummary: "Sent report for filing",
  });
}
