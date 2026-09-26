/**
 * Fixed asset register, monthly depreciation journals (one per asset per
 * month: source key `depreciation:<assetId>:<YYYY-MM>`) and disposal.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { depreciationSchedule, disposalLines, dueDepreciation, validateAsset, type AssetLike } from "../domain/assets.js";
import { AccountingError, addMonths, lastDayOfMonth, monthOf, requireDate, requireMinor, todayIso } from "../domain/util.js";
import { ensureBook, loadChart, roleAccount } from "./books.js";
import { errorMessage, newId, requireUser, type Actor } from "./common.js";
import { postJournal } from "./journals.js";

function asLike(a: db.AssetRow): AssetLike {
  return {
    id: a.id,
    name: a.name,
    costMinor: a.costMinor,
    residualMinor: a.residualMinor,
    lifeMonths: a.lifeMonths,
    depreciationStart: a.depreciationStart,
    openingThrough: a.openingThrough,
    status: a.status,
    disposedDate: a.disposedDate,
  };
}

export async function saveAsset(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<db.AssetRow> {
  await ensureBook(ctx, companyId);
  const valid = validateAsset(input);
  const chart = await loadChart(ctx, companyId);
  const pick = (value: unknown, role: string, subtypes: string[], label: string) => {
    const code = typeof value === "string" && value.trim() ? value.trim() : roleAccount(chart, role)?.code ?? "";
    const account = chart.byCode.get(code);
    if (!account) throw new AccountingError(`Choose the ${label} account`, "unknown_account");
    if (!subtypes.includes(account.subtype)) throw new AccountingError(`${code} ${account.name} cannot be the ${label} account`);
    return code;
  };
  const asset: db.AssetRow = {
    id: newId(),
    companyId,
    ...valid,
    assetAccountCode: pick(input.assetAccountCode, "fixed_assets", ["fixed_asset"], "asset (cost)"),
    accumulatedAccountCode: pick(input.accumulatedAccountCode, "accumulated_depreciation", ["accumulated_depreciation"], "accumulated depreciation"),
    expenseAccountCode: pick(input.expenseAccountCode, "depreciation", ["depreciation", "expense"], "depreciation expense"),
    status: "active",
    disposedDate: null,
    disposalProceedsMinor: null,
    disposalAccountCode: null,
    disposalJournalId: null,
  };
  await db.insertAsset(ctx.db, asset);
  return asset;
}

export async function assetDetail(ctx: PluginContext, companyId: string, id: string) {
  const asset = await db.getAsset(ctx.db, companyId, id);
  if (!asset) throw new AccountingError("Asset not found", "not_found");
  const posted = await db.journalsWithSourcePrefix(ctx.db, companyId, `depreciation:${asset.id}:`);
  const postedMonths = new Set(posted.map((j) => j.sourceKey.split(":").pop()!));
  return {
    asset,
    schedule: depreciationSchedule(asLike(asset)).map((row) => ({
      ...row,
      posted: postedMonths.has(row.month),
      beforeCutover: Boolean(asset.openingThrough && row.month <= asset.openingThrough),
      journalNumber: posted.find((j) => j.sourceKey.endsWith(`:${row.month}`))?.number ?? null,
    })),
  };
}

/** Post every depreciation month due up to `throughMonth` (default: last month). */
export async function runDepreciation(ctx: PluginContext, companyId: string, actor: Actor, throughInput?: unknown) {
  const through = typeof throughInput === "string" && /^\d{4}-\d{2}$/.test(throughInput) ? throughInput : addMonths(monthOf(todayIso()), -1);
  const assets = await db.listAssets(ctx.db, companyId);
  const posted: string[] = [];
  const problems: string[] = [];
  for (const asset of assets) {
    const existing = await db.journalsWithSourcePrefix(ctx.db, companyId, `depreciation:${asset.id}:`);
    const months = new Set(existing.map((j) => j.sourceKey.split(":").pop()!));
    for (const row of dueDepreciation(asLike(asset), through, months)) {
      try {
        const { journal, created } = await postJournal(ctx, companyId, {
          sourceKey: `depreciation:${asset.id}:${row.month}`,
          source: { plugin: "partnersinbiz.accounting", kind: "depreciation", id: asset.id },
          kind: "depreciation",
          date: lastDayOfMonth(row.month),
          memo: `Depreciation ${row.month}: ${asset.name}`,
          lines: [
            { accountCode: asset.expenseAccountCode, debitMinor: row.amountMinor, creditMinor: 0, memo: asset.name, dimensions: { assetId: asset.id } },
            { accountCode: asset.accumulatedAccountCode, debitMinor: 0, creditMinor: row.amountMinor, memo: asset.name, dimensions: { assetId: asset.id } },
          ],
          postedBy: actor,
        });
        if (created) posted.push(journal.number);
      } catch (error) {
        problems.push(`${asset.name} ${row.month}: ${errorMessage(error)}`);
        break;
      }
    }
  }
  return { through, posted, problems };
}

export async function disposeAsset(ctx: PluginContext, companyId: string, actor: Actor, input: { assetId?: unknown; date?: unknown; proceedsMinor?: unknown; proceedsAccountCode?: unknown }) {
  requireUser(actor, "dispose of an asset");
  const asset = typeof input.assetId === "string" ? await db.getAsset(ctx.db, companyId, input.assetId) : null;
  if (!asset) throw new AccountingError("Asset not found", "not_found");
  if (asset.status !== "active") throw new AccountingError("This asset is already disposed", "conflict");
  const date = requireDate(input.date ?? todayIso(), "date");
  const proceeds = input.proceedsMinor == null || input.proceedsMinor === "" ? 0 : requireMinor(input.proceedsMinor, "proceedsMinor");
  const chart = await loadChart(ctx, companyId);
  const proceedsCode = typeof input.proceedsAccountCode === "string" && input.proceedsAccountCode ? input.proceedsAccountCode : roleAccount(chart, "bank")?.code ?? "";
  if (proceeds > 0 && !chart.byCode.has(proceedsCode)) throw new AccountingError("Choose the account the proceeds went to", "unknown_account");
  const gainLoss = chart.roles.get("expense:disposal") ?? "6420";
  if (!chart.byCode.has(gainLoss)) throw new AccountingError("Map the role expense:disposal to the profit/loss on disposal account", "unknown_role");
  // Catch up depreciation to the month before disposal.
  const catchUp = await runDepreciation(ctx, companyId, actor, addMonths(monthOf(date), -1));
  if (catchUp.problems.length) throw new AccountingError(`Depreciation could not catch up first: ${catchUp.problems.join("; ")}`);
  const posted = await db.journalsWithSourcePrefix(ctx.db, companyId, `depreciation:${asset.id}:`);
  const accumulated =
    asset.openingAccumulatedMinor +
    posted.reduce((s, j) => s + j.lines.filter((l) => l.accountCode === asset.accumulatedAccountCode).reduce((x, l) => x + l.creditMinor - l.debitMinor, 0), 0);
  const { lines, gainMinor } = disposalLines({
    costMinor: asset.costMinor,
    accumulatedMinor: Math.min(accumulated, asset.costMinor),
    proceedsMinor: proceeds,
    assetCode: asset.assetAccountCode,
    accumulatedCode: asset.accumulatedAccountCode,
    proceedsCode,
    gainLossCode: gainLoss,
    memo: `Disposal: ${asset.name}`,
  });
  const { journal } = await postJournal(ctx, companyId, {
    sourceKey: `disposal:${asset.id}`,
    source: { plugin: "partnersinbiz.accounting", kind: "asset_disposal", id: asset.id },
    kind: "disposal",
    date,
    memo: `Disposal of ${asset.name}`,
    lines,
    postedBy: actor,
  });
  await db.markAssetDisposed(ctx.db, companyId, asset.id, { date, proceedsMinor: proceeds, accountCode: proceedsCode, journalId: journal.id });
  return { journal, gainMinor, accumulatedMinor: accumulated };
}

/** Job: depreciation for every company with assets, through last month. */
export async function depreciationJob(ctx: PluginContext, companies: string[]) {
  const out: Record<string, unknown> = {};
  for (const companyId of companies) {
    try {
      out[companyId] = await runDepreciation(ctx, companyId, { kind: "system", reason: "Monthly depreciation job" });
    } catch (error) {
      out[companyId] = { error: errorMessage(error) };
    }
  }
  return out;
}
