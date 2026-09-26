import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  configSaved,
  createSkillSyncer,
  decisionConfig,
  decisionStats,
  isModuleEnabled,
  LEDGER_EVENTS,
  LEDGER_SOURCES,
  linkAgent,
  MAIL_EVENTS,
  OPEN_ITEM_EVENTS,
  PIB_PLUGINS,
  pluginEvent,
  redeliver,
  registerHireWatch,
  registerModuleWatch,
  rememberPluginUiBase,
  SecretResolver,
  startHire,
  toolFail,
  toolOk,
  unlinkAgent,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "./db.js";
import { ROLE_LABELS } from "./domain/chart.js";
import { AccountingError, addMonths, monthOf, todayIso } from "./domain/util.js";
import { MANUAL_VAT_FIELDS, VAT_FIELD_LABELS, VAT_FIELDS } from "./domain/vat.js";
import { PLUGIN_ID } from "./namespace.js";
import { assetDetail, depreciationJob, disposeAsset, runDepreciation, saveAsset } from "./service/assets.js";
import {
  BOOKKEEPER_ROLE,
  bookkeeper,
  hireOptions,
  hireView,
  monthEndCloseIssue,
  onBookkeeperLinked,
  tryLinkBookkeeper,
  wireAgent,
} from "./service/agent.js";
import {
  acceptSuggestion,
  categorise,
  excludeLine,
  importStatement,
  matchToJournal,
  matchToOpenItem,
  refreshSuggestions,
  saveBankAccount,
  saveRule,
  setBookkeeperLookup,
  statementUploadUrl,
  undoLine,
} from "./service/bank.js";
import { ensureBook, loadChart, mapRole, roleGaps, saveAccount, setPeriod } from "./service/books.js";
import { closeChecklist } from "./service/close.js";
import { commentOn, errorMessage, issueStatus, ORIGIN, privateR2, readSettings, requireUser, newId, type Actor } from "./service/common.js";
import { postCutover, previewCutover } from "./service/cutover.js";
import { fetchRates, revalueMonth } from "./service/fx.js";
import {
  approveDraft,
  cancelDraft,
  onDraftIssue,
  requestDraftApproval,
  reverseJournal,
  saveDraft,
  verifyJournalChain,
} from "./service/journals.js";
import { dismissRejection, receiveMail, receiveMatchResult, receiveOpenItem, receivePostRequest, retryRejection, senderOf } from "./service/ledger.js";
import { buildPack } from "./service/pack.js";
import { publishStatusThrottled, setupStatus } from "./service/setup.js";
import { approveReconciliation, onReconciliationIssue, prepareReconciliation, requestReconciliationApproval } from "./service/reconcile.js";
import { forecast, overview, runReport } from "./service/reports.js";
import { approveVatReturn, computeForPeriod, onVatIssue, prepareVatReturn, requestVatApproval, vatCsv, vatPeriods } from "./service/vat.js";
import { SKILLS } from "./skills.js";
import { ACCOUNTING_TOOLS } from "./tools.js";
import { vatPeriodFor } from "./domain/periods.js";

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const syncSkills = (companyId: string) => skillSync?.force(companyId) ?? Promise.resolve([]);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v.trim()) throw new AccountingError(`${key} is required`);
  return v.trim();
}

function optStr(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function actorOf(context: PluginPerformActionContext): Actor {
  const a = context.actor;
  if (a.type === "user" && a.userId) return { kind: "user", userId: a.userId };
  if (a.type === "agent" && a.agentId) return { kind: "agent", agentId: a.agentId, runId: a.runId ?? null, userId: null };
  return { kind: "system", reason: "action" };
}

// ---------------------------------------------------------------------------
// Page actions
// ---------------------------------------------------------------------------

type Handler = (ctx: PluginContext, companyId: string, actor: Actor, p: Record<string, unknown>) => Promise<unknown>;

async function withNames(ctx: PluginContext, companyId: string, journals: Awaited<ReturnType<typeof db.listJournals>>["journals"]) {
  const chart = await loadChart(ctx, companyId);
  return journals.map((j) => ({
    ...j,
    lines: j.lines.map((l) => ({ ...l, accountName: chart.byId.get(l.accountId)?.name ?? null })),
  }));
}

const ACTIONS: Record<string, Handler> = {
  "accounting.load": async (ctx, companyId, actor, p) => {
    // The page reports /_plugins/<installation uuid>/ui/ so the setup checklist can link to the settings.
    await rememberPluginUiBase(ctx, p.uiBase);
    const book = await ensureBook(ctx, companyId);
    void skillSync?.ensure(companyId);
    if (actor.kind === "user") await tryLinkBookkeeper(ctx, companyId, syncSkills);
    const settings = await readSettings(ctx, companyId);
    const chart = await loadChart(ctx, companyId);
    const jev = await decisionConfig(new SecretResolver(ctx, companyId, settings.raw), settings.raw).catch(() => null);
    const r2 = await privateR2(ctx, companyId, settings.raw).catch(() => null);
    return {
      book,
      settings: {
        saved: settings.saved,
        legalName: settings.legalName,
        vatNumber: settings.vatNumber,
        vatCategory: settings.vatCategory,
        yearEndMonth: settings.yearEndMonth,
        agentsMayAcceptCategorisation: settings.agentsMayAcceptCategorisation,
        jevConfigured: Boolean(jev),
        r2Configured: Boolean(r2),
      },
      overview: await overview(ctx, companyId),
      roleGaps: roleGaps(chart),
      bankAccounts: await db.listBankAccounts(ctx.db, companyId),
      accounts: chart.accounts,
      currentVatPeriod: vatPeriodFor(todayIso(), settings.vatCategory, settings.yearEndMonth),
      hire: actor.kind === "user" ? await hireView(ctx, companyId, actor.userId).catch(() => null) : null,
    };
  },

  // Chart and roles
  "accounting.chart": async (ctx, companyId) => {
    await ensureBook(ctx, companyId);
    const chart = await loadChart(ctx, companyId);
    return {
      accounts: chart.accounts,
      roles: [...chart.roles].map(([role, accountCode]) => ({ role, accountCode, label: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role, core: role in ROLE_LABELS })),
      gaps: roleGaps(chart),
      taxRates: await db.listTaxRates(ctx.db, companyId),
    };
  },
  "accounting.save-account": (ctx, companyId, actor, p) => {
    requireUser(actor, "change the chart of accounts");
    return saveAccount(ctx, companyId, p);
  },
  "accounting.map-role": (ctx, companyId, actor, p) => {
    requireUser(actor, "change where a role posts");
    return mapRole(ctx, companyId, p.role, p.accountCode);
  },

  // Journals
  "accounting.journals": async (ctx, companyId, _a, p) => {
    const { journals, total } = await db.listJournals(ctx.db, companyId, {
      from: optStr(p, "from"),
      to: optStr(p, "to"),
      kind: optStr(p, "kind"),
      search: optStr(p, "search"),
      accountId: optStr(p, "accountId"),
      limit: Number(p.limit ?? 50),
      offset: Number(p.offset ?? 0),
    });
    return { journals: await withNames(ctx, companyId, journals), total };
  },
  "accounting.journal": async (ctx, companyId, _a, p) => {
    const journal = await db.journalById(ctx.db, companyId, str(p, "journalId"));
    if (!journal) throw new AccountingError("Journal not found", "not_found");
    return (await withNames(ctx, companyId, [journal]))[0];
  },
  "accounting.reverse-journal": async (ctx, companyId, actor, p) => {
    requireUser(actor, "reverse a journal");
    return reverseJournal(ctx, companyId, str(p, "journalId"), { date: optStr(p, "date"), memo: optStr(p, "memo"), postedBy: actor });
  },
  "accounting.verify-chain": (ctx, companyId) => verifyJournalChain(ctx, companyId),
  "accounting.periods": async (ctx, companyId) => {
    const stored = await db.listPeriods(ctx.db, companyId);
    const now = monthOf(todayIso());
    const months = Array.from({ length: 18 }, (_, i) => addMonths(now, -i));
    return { periods: months.map((m) => stored.find((s) => s.period === m) ?? { period: m, status: "open", changedBy: null, changedAt: null }) };
  },
  "accounting.set-period": (ctx, companyId, actor, p) => {
    requireUser(actor, "open or close a period");
    return setPeriod(ctx, companyId, p.period, p.status, actor);
  },
  "accounting.close-checklist": (ctx, companyId, _a, p) => closeChecklist(ctx, companyId, optStr(p, "month") ?? undefined),

  // Manual journals
  "accounting.drafts": async (ctx, companyId) => ({ drafts: await db.listDrafts(ctx.db, companyId, ["draft", "pending_approval"]) }),
  "accounting.save-draft": (ctx, companyId, actor, p) => saveDraft(ctx, companyId, { id: optStr(p, "id"), date: p.date, memo: p.memo, currency: p.currency, fxRate: p.fxRate, lines: p.lines }, actor),
  "accounting.request-draft-approval": (ctx, companyId, actor, p) => requestDraftApproval(ctx, companyId, str(p, "draftId"), actor),
  "accounting.approve-draft": (ctx, companyId, actor, p) => approveDraft(ctx, companyId, str(p, "draftId"), actor),
  "accounting.cancel-draft": (ctx, companyId, _a, p) => cancelDraft(ctx, companyId, str(p, "draftId"), optStr(p, "reason")),

  // Rejected postings
  "accounting.rejections": async (ctx, companyId) => ({ rejections: await db.listRejections(ctx.db, companyId, "open") }),
  "accounting.retry-rejection": (ctx, companyId, actor, p) => {
    requireUser(actor, "retry a rejected posting");
    return retryRejection(ctx, companyId, str(p, "key"));
  },
  "accounting.dismiss-rejection": async (ctx, companyId, actor, p) => {
    requireUser(actor, "dismiss a rejected posting");
    await dismissRejection(ctx, companyId, str(p, "key"));
    return { ok: true };
  },

  // Bank
  "accounting.bank": async (ctx, companyId) => {
    await ensureBook(ctx, companyId);
    const [bankAccounts, statements, rules, reconciliations, counts] = await Promise.all([
      db.listBankAccounts(ctx.db, companyId),
      db.listStatements(ctx.db, companyId),
      db.listRules(ctx.db, companyId),
      db.listReconciliations(ctx.db, companyId),
      db.lineCounts(ctx.db, companyId),
    ]);
    return { bankAccounts, statements, rules, reconciliations, counts };
  },
  "accounting.save-bank-account": (ctx, companyId, actor, p) => {
    requireUser(actor, "add or change a bank account");
    return saveBankAccount(ctx, companyId, p);
  },
  "accounting.statement-upload-url": (ctx, companyId, _a, p) => statementUploadUrl(ctx, companyId, { fileName: p.fileName, bytes: p.bytes }),
  "accounting.import-statement": (ctx, companyId, actor, p) =>
    importStatement(ctx, companyId, actor, { bankAccountId: p.bankAccountId, content: p.content, objectKey: p.objectKey, fileName: p.fileName, format: p.format }),
  "accounting.bank-lines": async (ctx, companyId, _a, p) => {
    const statuses = Array.isArray(p.statuses) ? p.statuses.map(String) : optStr(p, "status") ? [optStr(p, "status")!] : null;
    const lines = await db.listBankLines(ctx.db, companyId, { bankAccountId: optStr(p, "bankAccountId"), statuses, from: optStr(p, "from"), to: optStr(p, "to"), limit: Number(p.limit ?? 300) });
    const openItems = await db.listOpenItems(ctx.db, companyId, { currency: "ZAR" });
    return { lines, openItems };
  },
  "accounting.refresh-suggestions": (ctx, companyId, _a, p) =>
    refreshSuggestions(ctx, companyId, { bankAccountId: optStr(p, "bankAccountId"), lineIds: Array.isArray(p.lineIds) ? p.lineIds.map(String) : null, useJev: p.useJev !== false }),
  "accounting.accept-suggestion": (ctx, companyId, actor, p) => acceptSuggestion(ctx, companyId, actor, { lineId: p.lineId, index: p.index }),
  "accounting.categorise": (ctx, companyId, actor, p) => categorise(ctx, companyId, actor, { lineId: p.lineId, accountCode: p.accountCode, taxCode: p.taxCode, memo: p.memo, counterparty: p.counterparty }),
  "accounting.match-open-item": (ctx, companyId, actor, p) => matchToOpenItem(ctx, companyId, actor, { lineId: p.lineId, openItemKey: p.openItemKey }),
  "accounting.match-journal": (ctx, companyId, actor, p) => matchToJournal(ctx, companyId, actor, { lineId: p.lineId, journalId: p.journalId }),
  "accounting.exclude-line": (ctx, companyId, actor, p) => excludeLine(ctx, companyId, actor, { lineId: p.lineId, note: p.note }),
  "accounting.undo-line": (ctx, companyId, actor, p) => undoLine(ctx, companyId, actor, { lineId: p.lineId }),
  "accounting.save-rule": (ctx, companyId, _a, p) => saveRule(ctx, companyId, p),
  "accounting.delete-rule": async (ctx, companyId, _a, p) => ({ deleted: await db.deleteRule(ctx.db, companyId, str(p, "ruleId")) }),
  "accounting.prepare-reconciliation": (ctx, companyId, actor, p) => prepareReconciliation(ctx, companyId, actor, p),
  "accounting.request-reconciliation-approval": (ctx, companyId, actor, p) => requestReconciliationApproval(ctx, companyId, actor, str(p, "reconciliationId")),
  "accounting.approve-reconciliation": (ctx, companyId, actor, p) => approveReconciliation(ctx, companyId, actor, str(p, "reconciliationId")),

  // VAT
  "accounting.vat": async (ctx, companyId) => {
    await ensureBook(ctx, companyId);
    const periods = await vatPeriods(ctx, companyId);
    return { ...periods, returns: await db.listVatReturns(ctx.db, companyId), labels: VAT_FIELD_LABELS, fields: VAT_FIELDS, manualFields: MANUAL_VAT_FIELDS };
  },
  "accounting.prepare-vat": (ctx, companyId, actor, p) => prepareVatReturn(ctx, companyId, actor, { periodStart: p.periodStart, periodEnd: p.periodEnd, adjustments: p.adjustments }),
  "accounting.request-vat-approval": (ctx, companyId, actor, p) => requestVatApproval(ctx, companyId, actor, str(p, "returnId")),
  "accounting.approve-vat": (ctx, companyId, actor, p) => approveVatReturn(ctx, companyId, actor, str(p, "returnId")),
  "accounting.vat-csv": (ctx, companyId, _a, p) => vatCsv(ctx, companyId, str(p, "returnId")),

  // Reports
  "accounting.report": (ctx, companyId, _a, p) => runReport(ctx, companyId, p.kind, p),

  // Assets and FX
  "accounting.assets": async (ctx, companyId, _a, p) => {
    await ensureBook(ctx, companyId);
    const id = optStr(p, "assetId");
    if (id) return assetDetail(ctx, companyId, id);
    return { assets: await db.listAssets(ctx.db, companyId) };
  },
  "accounting.save-asset": (ctx, companyId, _a, p) => saveAsset(ctx, companyId, p),
  "accounting.dispose-asset": (ctx, companyId, actor, p) => disposeAsset(ctx, companyId, actor, { assetId: p.assetId, date: p.date, proceedsMinor: p.proceedsMinor, proceedsAccountCode: p.proceedsAccountCode }),
  "accounting.run-depreciation": (ctx, companyId, actor, p) => {
    requireUser(actor, "post depreciation");
    return runDepreciation(ctx, companyId, actor, p.through);
  },
  "accounting.fx": async (ctx, companyId) => ({
    rates: await db.latestRates(ctx.db, "ZAR"),
    foreignItems: (await db.listOpenItems(ctx.db, companyId)).filter((i) => i.currency !== "ZAR"),
  }),
  "accounting.fetch-fx": async (ctx, _companyId, actor) => {
    requireUser(actor, "fetch FX rates");
    return fetchRates(ctx);
  },
  "accounting.revalue-fx": (ctx, companyId, actor, p) => {
    requireUser(actor, "post an FX revaluation");
    return revalueMonth(ctx, companyId, actor, optStr(p, "month") ?? undefined);
  },

  // Budgets and forecast
  "accounting.budgets": async (ctx, companyId, _a, p) => {
    const from = optStr(p, "fromMonth") ?? monthOf(todayIso());
    const to = optStr(p, "toMonth") ?? addMonths(from, 11);
    return { fromMonth: from, toMonth: to, budgets: await db.listBudgets(ctx.db, companyId, from, to) };
  },
  "accounting.save-budgets": async (ctx, companyId, _a, p) => {
    const rows = Array.isArray(p.budgets) ? p.budgets : [];
    const clean = rows.map((r) => {
      const row = obj(r);
      const month = String(row.month ?? "");
      const amount = Number(row.amountMinor);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new AccountingError("Budget months are YYYY-MM");
      if (!Number.isSafeInteger(amount)) throw new AccountingError("Budget amounts are whole cents");
      return { account_code: str(row, "accountCode"), month, amount_minor: amount };
    });
    return { saved: await db.saveBudgets(ctx.db, companyId, clean) };
  },
  "accounting.forecast": (ctx, companyId, _a, p) => forecast(ctx, companyId, Number(p.months ?? 3)),
  "accounting.save-forecast-line": async (ctx, companyId, _a, p) => {
    const amount = Number(p.amountMinor);
    const month = str(p, "month");
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AccountingError("month is YYYY-MM");
    if (!Number.isSafeInteger(amount) || amount === 0) throw new AccountingError("amountMinor is whole cents (negative for money out)");
    const line = { id: newId(), month, description: str(p, "description").slice(0, 200), amountMinor: amount, repeat: p.repeat === "monthly" ? ("monthly" as const) : ("none" as const), untilMonth: optStr(p, "untilMonth") };
    await db.insertForecastLine(ctx.db, companyId, line);
    return line;
  },
  "accounting.delete-forecast-line": async (ctx, companyId, _a, p) => ({ deleted: await db.deleteForecastLine(ctx.db, companyId, str(p, "id")) }),

  // Cut-over and the accountant pack
  "accounting.cutover-preview": (ctx, companyId, _a, p) => previewCutover(ctx, companyId, { csv: p.csv }),
  "accounting.cutover-post": (ctx, companyId, actor, p) => postCutover(ctx, companyId, actor, { csv: p.csv, date: p.date, balanceToEquity: p.balanceToEquity }),
  "accounting.pack": (ctx, companyId, actor, p) => buildPack(ctx, companyId, actor, { from: p.from, to: p.to }),
  "accounting.decisions": async (ctx, companyId) => ({ stats: await decisionStats(ctx, companyId, 90) }),

  // The Bookkeeper
  "accounting.hire-options": (ctx, companyId, actor) => {
    requireUser(actor, "hire the Bookkeeper");
    return hireOptions(ctx, companyId);
  },
  "accounting.start-hire": async (ctx, companyId, actor, p) => {
    const actorUserId = requireUser(actor, "hire the Bookkeeper");
    return {
      hire: await startHire(ctx, companyId, BOOKKEEPER_ROLE, {
        title: optStr(p, "title") ?? undefined,
        description: optStr(p, "description") ?? undefined,
        assigneeAgentId: optStr(p, "assigneeAgentId"),
        assigneeUserId: optStr(p, "assigneeUserId"),
        actorUserId,
      }),
    };
  },
  "accounting.link-agent": async (ctx, companyId, actor, p) => {
    const userId = requireUser(actor, "link the Bookkeeper");
    let wired: Awaited<ReturnType<typeof wireAgent>> | null = null;
    const { agent, steps } = await linkAgent(ctx, companyId, BOOKKEEPER_ROLE, str(p, "agentId"), {
      by: "manual",
      userId,
      onLinked: async (c, agentId, by) => {
        wired = await wireAgent(ctx, c, agentId, by.userId, syncSkills);
        return wired.steps;
      },
    });
    return { agent, steps, instructions: (wired as { instructions?: string[] } | null)?.instructions ?? [] };
  },
  "accounting.unlink-agent": async (ctx, companyId, actor) => {
    requireUser(actor, "unlink the Bookkeeper");
    await unlinkAgent(ctx, companyId, BOOKKEEPER_ROLE);
    return { ok: true };
  },
  "accounting.resync-agent": async (ctx, companyId, actor) => {
    const userId = requireUser(actor, "re-sync the Bookkeeper");
    const agent = await bookkeeper(ctx, companyId);
    if (!agent) throw new AccountingError("No Bookkeeper is linked yet. Use Hire Bookkeeper, or Link agent to pick one that exists.");
    return wireAgent(ctx, companyId, agent.id, userId, syncSkills);
  },
  "accounting.sync-skills": async (_ctx, companyId, actor) => {
    requireUser(actor, "sync skills");
    return { results: await syncSkills(companyId) };
  },
};

async function runAction(ctx: PluginContext, key: string, handler: Handler, params: unknown, context: PluginPerformActionContext): Promise<unknown> {
  const companyId = context.companyId ?? context.actor.companyId;
  if (!companyId) throw new AccountingError("Company is required");
  try {
    return await handler(ctx, companyId, actorOf(context), obj(params));
  } catch (error) {
    if (!(error instanceof AccountingError)) ctx.logger.warn("Accounting action failed", { key, error: errorMessage(error) });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

async function dispatchTool(ctx: PluginContext, name: string, p: Record<string, unknown>, run: ToolRunContext): Promise<unknown> {
  const companyId = run.companyId;
  const actor: Actor = { kind: "agent", agentId: run.agentId, runId: run.runId, userId: null };
  await ensureBook(ctx, companyId);
  switch (name) {
    case "list-accounts": {
      const chart = await loadChart(ctx, companyId);
      return {
        accounts: chart.accounts.filter((a) => p.activeOnly === false || a.active).map((a) => ({ code: a.code, name: a.name, type: a.type, kind: a.subtype, active: a.active })),
        roles: Object.fromEntries(chart.roles),
      };
    }
    case "list-bank-lines": {
      const lines = await db.listBankLines(ctx.db, companyId, {
        bankAccountId: optStr(p, "bankAccountId"),
        statuses: optStr(p, "status") ? [optStr(p, "status")!] : null,
        from: optStr(p, "from"),
        to: optStr(p, "to"),
        limit: Math.min(Number(p.limit ?? 100), 500),
      });
      return {
        lines: lines.map((l) => ({
          id: l.id,
          bankAccountId: l.bankAccountId,
          date: l.date,
          amountMinor: l.amountMinor,
          description: l.description,
          reference: l.reference,
          counterparty: l.counterparty,
          status: l.status,
          note: l.note,
          suggestions: l.suggestions.map((s, index) => ({ index, ...s })),
        })),
      };
    }
    case "suggest-categorisation":
      return refreshSuggestions(ctx, companyId, { bankAccountId: optStr(p, "bankAccountId"), lineIds: Array.isArray(p.lineIds) ? p.lineIds.map(String) : null, useJev: true });
    case "accept-categorisation":
      if (optStr(p, "accountCode")) return categorise(ctx, companyId, actor, { lineId: p.lineId, accountCode: p.accountCode, taxCode: p.taxCode, memo: p.memo });
      return acceptSuggestion(ctx, companyId, actor, { lineId: p.lineId, index: p.index });
    case "trial-balance":
      return runReport(ctx, companyId, "trial_balance", p);
    case "pnl":
      return runReport(ctx, companyId, "profit_and_loss", p);
    case "balance-sheet":
      return runReport(ctx, companyId, "balance_sheet", p);
    case "gl":
      return runReport(ctx, companyId, "general_ledger", p);
    case "vat-summary": {
      const settings = await readSettings(ctx, companyId);
      let start = optStr(p, "periodStart");
      let end = optStr(p, "periodEnd");
      if (!start || !end) {
        const period = vatPeriodFor(optStr(p, "date") ?? todayIso(), settings.vatCategory, settings.yearEndMonth);
        if (!period) throw new AccountingError("The company is not VAT-registered in the Accounting settings");
        start = period.start;
        end = period.end;
      }
      const saved = await db.vatReturnByPeriod(ctx.db, companyId, start, end);
      const result = await computeForPeriod(ctx, companyId, start, end, (saved?.adjustments ?? {}) as Record<string, number>);
      return { periodStart: start, periodEnd: end, status: saved?.status ?? "not_prepared", boxes: result.boxes, labels: VAT_FIELD_LABELS, warnings: result.warnings };
    }
    case "create-manual-journal": {
      const draft = await saveDraft(ctx, companyId, { date: p.date, memo: p.memo, lines: p.lines }, actor);
      return requestDraftApproval(ctx, companyId, draft.id, actor);
    }
    case "period-close-checklist":
      return closeChecklist(ctx, companyId, optStr(p, "month") ?? undefined);
    default:
      throw new AccountingError(`Unknown accounting tool ${name}`);
  }
}

function toolContent(data: unknown): string {
  const json = JSON.stringify(data, null, 2) ?? "null";
  return json.length > 24_000 ? `${json.slice(0, 24_000)}\n… (truncated; narrow the request)` : json;
}

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    void skillSync?.ensure(run.companyId);
    const data = await dispatchTool(ctx, name, obj(params), run);
    // MCP structuredContent must be an object; toolOk wraps lists and scalars.
    return toolOk(toolContent(data), data);
  } catch (error) {
    return toolFail(error instanceof Error ? error.message : "Accounting tool failed");
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function safely(ctx: PluginContext, label: string, fn: (event: PluginEvent) => Promise<unknown>) {
  return async (event: PluginEvent) => {
    try {
      if (!event.companyId) return;
      await fn(event);
    } catch (error) {
      ctx.logger.warn(`${label} failed`, { eventType: event.eventType, error: errorMessage(error) });
    }
  };
}

/** Approval issues: a person marking one done approves; cancelling it withdraws the request. */
async function onIssueUpdated(ctx: PluginContext, event: PluginEvent) {
  const issueId = event.entityId;
  if (!issueId) return;
  const issue = await ctx.issues.get(issueId, event.companyId).catch(() => null);
  if (!issue || issue.originKind !== ORIGIN || !issue.originId) return;
  const status = String(issue.status);
  if (status !== "done" && status !== "cancelled") return;
  const actor = { type: event.actorType, id: event.actorId };
  const colon = issue.originId.indexOf(":");
  if (colon < 0) return;
  const kind = issue.originId.slice(0, colon);
  const id = issue.originId.slice(colon + 1);
  if (kind === "draft") {
    const draft = await db.getDraft(ctx.db, event.companyId, id);
    if (draft) await onDraftIssue(ctx, event.companyId, draft, status, actor);
  } else if (kind === "reconciliation") {
    const rec = await db.getReconciliation(ctx.db, event.companyId, id);
    if (rec) await onReconciliationIssue(ctx, event.companyId, rec, status, actor);
  } else if (kind === "vat") {
    const ret = await db.getVatReturn(ctx.db, event.companyId, id);
    if (ret) await onVatIssue(ctx, event.companyId, ret, status, actor);
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function savedCompanies(ctx: PluginContext): Promise<string[]> {
  const out: string[] = [];
  for (const companyId of await db.bookCompanies(ctx.db)) if (await configSaved(ctx, companyId)) out.push(companyId);
  return out;
}

/** Saved companies that have not switched Accounting off in Setup (for new automatic work). */
export async function enabledCompanies(ctx: PluginContext, companies: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const companyId of companies) if (await isModuleEnabled(ctx, companyId, PLUGIN_ID)) out.push(companyId);
  return out;
}

/** Pending approvals whose issue closed while the event was missed. */
async function sweepApprovals(ctx: PluginContext, companies: Set<string>) {
  const note = async (companyId: string, issueId: string | null, what: string) => {
    if (!issueId) return;
    if (!(await db.setMark(ctx.db, companyId, `approval-note:${issueId}`))) return;
    await commentOn(ctx, companyId, issueId, `This issue is done, but the plugin could not confirm who closed it, so the ${what} was not approved. A board user can approve it in Accounting.`);
  };
  for (const d of await db.pendingDrafts(ctx.db)) {
    if (!companies.has(d.companyId)) continue;
    const s = await issueStatus(ctx, d.companyId, d.approvalIssueId);
    if (s === "cancelled") await onDraftIssue(ctx, d.companyId, d, "cancelled", {});
    else if (s === "done") await note(d.companyId, d.approvalIssueId, "journal");
  }
  for (const r of await db.pendingReconciliations(ctx.db)) {
    if (!companies.has(r.companyId)) continue;
    const s = await issueStatus(ctx, r.companyId, r.approvalIssueId);
    if (s === "cancelled") await onReconciliationIssue(ctx, r.companyId, r, "cancelled", {});
    else if (s === "done") await note(r.companyId, r.approvalIssueId, "reconciliation");
  }
  for (const v of await db.pendingVatReturns(ctx.db)) {
    if (!companies.has(v.companyId)) continue;
    const s = await issueStatus(ctx, v.companyId, v.approvalIssueId);
    if (s === "cancelled") await onVatIssue(ctx, v.companyId, v, "cancelled", {});
    else if (s === "done") await note(v.companyId, v.approvalIssueId, "VAT return");
  }
}

async function redeliverJob(ctx: PluginContext) {
  const companies = await savedCompanies(ctx);
  // In-flight work keeps running for every company: outbox redelivery and approvals already asked for.
  const outbox = await redeliver(ctx);
  await sweepApprovals(ctx, new Set(companies));
  const enabled = await enabledCompanies(ctx, companies);
  for (const companyId of enabled) await tryLinkBookkeeper(ctx, companyId, syncSkills);
  let published = 0;
  for (const companyId of enabled) if (await publishStatusThrottled(ctx, companyId)) published += 1;
  return { outbox, companies: companies.length, enabled: enabled.length, published };
}

async function monthEndJob(ctx: PluginContext) {
  const companies = await enabledCompanies(ctx, await savedCompanies(ctx));
  const depreciation = await depreciationJob(ctx, companies);
  const fx: Record<string, unknown> = {};
  const closeIssues: Record<string, unknown> = {};
  const lastMonth = addMonths(monthOf(todayIso()), -1);
  for (const companyId of companies) {
    if (new Date().getUTCDate() <= 7) {
      try {
        fx[companyId] = await revalueMonth(ctx, companyId, { kind: "system", reason: "Month-end FX revaluation" }, lastMonth);
      } catch (error) {
        fx[companyId] = { error: errorMessage(error) };
      }
    }
    closeIssues[companyId] = await monthEndCloseIssue(ctx, companyId).catch((error) => ({ error: errorMessage(error) }));
  }
  return { depreciation, fx, closeIssues };
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (input.routeKey === "setup-status") return { status: 200, body: await setupStatus(ctx, input.companyId) };
  return { status: 404, body: { error: "Not found" } };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    setBookkeeperLookup((c, companyId) => bookkeeper(c, companyId));

    for (const tool of ACCOUNTING_TOOLS) ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    for (const [key, handler] of Object.entries(ACTIONS)) ctx.actions.register(key, (params, context) => runAction(ctx, key, handler, params, context));

    for (const sender of LEDGER_SOURCES) {
      ctx.events.on(pluginEvent(sender, LEDGER_EVENTS.postRequested), safely(ctx, "Ledger posting", (e) => receivePostRequest(ctx, e.companyId, e.eventType, e.payload)));
    }
    ctx.events.on(
      pluginEvent(PIB_PLUGINS.billing, OPEN_ITEM_EVENTS.upserted),
      safely(ctx, "Open item", (e) => receiveOpenItem(ctx, e.companyId, senderOf(e.eventType, OPEN_ITEM_EVENTS.upserted), e.payload)),
    );
    ctx.events.on(pluginEvent(PIB_PLUGINS.billing, OPEN_ITEM_EVENTS.bankMatchResult), safely(ctx, "Bank match result", (e) => receiveMatchResult(ctx, e.companyId, e.payload)));
    ctx.events.on(
      pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.received),
      safely(ctx, "Statement email", async (e) => ((await isModuleEnabled(ctx, e.companyId, PLUGIN_ID)) ? receiveMail(ctx, e.companyId, e.eventType, e.payload) : false)),
    );
    ctx.events.on("issue.updated", safely(ctx, "Approval issue", (e) => onIssueUpdated(ctx, e)));
    ctx.events.on("company.created", safely(ctx, "Skill sync", (e) => skillSync!.ensure(e.companyId)));
    registerHireWatch(ctx, [{ role: BOOKKEEPER_ROLE, onLinked: onBookkeeperLinked(ctx, syncSkills) }]);
    registerModuleWatch(ctx);

    ctx.jobs.register("redeliver", async () => {
      const result = await redeliverJob(ctx);
      if (result.outbox.emitted || result.outbox.failed) ctx.logger.info("Accounting redeliver", result);
    });
    ctx.jobs.register("month-end", async () => {
      ctx.logger.info("Accounting month-end", await monthEndJob(ctx));
    });
    ctx.jobs.register("fx-rates", async () => {
      ctx.logger.info("FX rates stored", await fetchRates(ctx));
    });
    ctx.logger.info("Accounting plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Accounting plugin ready" };
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Accounting plugin is not ready" } };
    return handleApiRequest(pluginCtx, input);
  },
  async onConfigChanged(_config, context) {
    const companyId = context?.companyId;
    if (!pluginCtx || !companyId) return;
    try {
      await ensureBook(pluginCtx, companyId);
      await skillSync?.ensure(companyId);
    } catch (error) {
      pluginCtx.logger.warn("Book setup after settings save failed", { companyId, error: errorMessage(error) });
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

export { PLUGIN_ID };
