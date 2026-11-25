/**
 * Planning Canvas rollback (plan PAR-13925 J.7): rebuild each board's legacy
 * `data` blob from its live item rows, so code from before the item cutover
 * reads current boards. Run before old code serves:
 *
 *   pnpm tsx scripts/planning-canvas-rebuild-blob.ts --company <companyId|all>
 *
 * Boards over the old 500 caps (or whose blob fails the old validator) are
 * listed and left unchanged, for a person to decide. Exit code 2 when any
 * board was left unchanged.
 */
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { rebuildPlanningCanvasLegacyBlobs } from "../server/src/services/planning-canvases.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const company = parseFlag("--company");
  if (!company) {
    console.error("Usage: pnpm tsx scripts/planning-canvas-rebuild-blob.ts --company <companyId|all>");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    const report = await rebuildPlanningCanvasLegacyBlobs(db, { companyId: company });
    console.log(`Rebuilt ${report.rebuilt.length} planning canvas blob(s).`);
    for (const board of report.overOldCaps) {
      console.log(
        `LEFT UNCHANGED (over old caps) board ${board.boardId} company ${board.companyId}: ` +
          `${board.nodes} nodes, ${board.connectors} connectors, ${board.strokes} strokes`,
      );
    }
    for (const board of report.invalid) {
      console.log(`LEFT UNCHANGED (old validator) board ${board.boardId} company ${board.companyId}: ${board.error}`);
    }
    if (report.overOldCaps.length > 0 || report.invalid.length > 0) process.exitCode = 2;
  } finally {
    await db.$client.end();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Planning canvas blob rebuild failed: ${message}`);
  process.exitCode = 1;
});
