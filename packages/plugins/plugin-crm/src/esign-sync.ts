/**
 * Writes the signing pages for every company's documents again from the records. A deploy removes the pages (the deploy
 * script copies `dist/` with `--delete`), so this runs when the worker starts, and the care job runs it too.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { syncPages, type SyncResult } from "./esign-link.js";
import { companiesWithDocs, listDocs, type SignDocument } from "./esign-store.js";

/** The most documents read per company in one sweep. A company that reaches it is not fully read, so no unknown page is removed. */
export const SYNC_DOCS_PER_COMPANY = 500;

export async function syncAllPages(ctx: PluginContext): Promise<SyncResult> {
  const docs: SignDocument[] = [];
  let complete = true;
  for (const companyId of await companiesWithDocs(ctx)) {
    try {
      const read = await listDocs(ctx, companyId, null, SYNC_DOCS_PER_COMPANY);
      if (read.length >= SYNC_DOCS_PER_COMPANY) complete = false;
      docs.push(...read);
    } catch (error) {
      complete = false;
      ctx.logger.info("CRM signing pages: documents could not be read", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Pages nobody has a record for are removed only when every company was read, so a failing company never costs another's pages.
  return syncPages(docs, Date.now(), { removeOrphans: complete });
}
