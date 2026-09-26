/**
 * Payroll worker: page actions (board), agent tools (masked, prepare-only),
 * event handlers (approval issues, Accounting and Mailbox results) and jobs.
 */
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginEvent,
  type PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";
import {
  COCKPIT_ROUTE,
  createSkillSyncer,
  hireStatus,
  hireTaskDraft,
  LEDGER_EVENTS,
  linkAgent,
  listCompanyAgents,
  PIB_PLUGINS,
  pluginEvent,
  redeliver,
  registerHireWatch,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  SETUP_STATUS_ROUTE,
  startHire,
  trackJob,
  tryLinkPendingHire,
  unlinkAgent,
  MAIL_EVENTS,
} from "@partnersinbiz/pib-plugin-kit";
import { mergeComponents } from "./components.js";
import * as db from "./db.js";
import type { Actor } from "./domain.js";
import { CLERK_ROLE, clerkOnLinked } from "./hire.js";
import { PayrollError } from "./money.js";
import { taxYearOf } from "./rules.js";
import { SKILLS } from "./skills.js";
import { PAYROLL_TOOLS } from "./tools.js";
import { employeeView, revealEmployeeField, saveComponent, saveEmployee, saveTerms, setRecurring, terminateEmployee, termsView } from "./service/employees.js";
import { actionActor, asParams, assignableUser, createEnv, errorMessage, optStr, reqStr, requireUser, today, type Env } from "./service/env.js";
import { cancelLeave, decideLeave, leaveOverview, onLeaveIssueUpdated, requestLeave, setLeaveOpening } from "./service/leave.js";
import { emailPayslips, generatePayslips, onMailResult, payslipDownload, queuePayslipEmails } from "./service/payslips.js";
import {
  adjustItem,
  approveRun,
  calculateRun,
  cancelRun,
  correctRun,
  createRun,
  lockRun,
  onApprovalIssueUpdated,
  onLedgerResult,
  rejectRun,
  repostLedger,
  requestApproval,
  requireRun,
  reverseRun,
  runDetail,
  runSummary,
  runVariances,
} from "./service/runs.js";
import { certificates, emp201, emp501, exportDownload, exportStatutory, importYtd, netPayFile } from "./service/statutory.js";
import { overview, rulesView, runTool } from "./service/agent-tools.js";
import { followUp } from "./service/jobs.js";
import { cockpitSnapshot } from "./service/cockpit.js";
import { markRulesReviewed, rulesReviewed, setupStatus } from "./service/setup.js";

export const LEDGER_RESULT_EVENT = pluginEvent(PIB_PLUGINS.accounting, LEDGER_EVENTS.postResult);
export const MAIL_RESULT_EVENT = pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult);

let env: Env | null = null;
let skills: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    env = createEnv(ctx);
    skills = createSkillSyncer(ctx, SKILLS);
    const e = env;
    const onLinked = clerkOnLinked(ctx, (companyId) => skills!.force(companyId));
    registerHireWatch(ctx, [{ role: CLERK_ROLE, onLinked }]);
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);
    registerActions(e, onLinked);

    for (const tool of PAYROLL_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skills?.ensure(run.companyId);
        return runTool(e, tool.name, asParams(params), run);
      });
    }

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      if (!event.entityId || !event.companyId) return;
      try {
        await onApprovalIssueUpdated(e, event.companyId, event.entityId, { actorType: event.actorType, actorId: event.actorId, status: statusOf(event.payload) });
        await onLeaveIssueUpdated(e, event.companyId, event.entityId, { actorType: event.actorType, actorId: event.actorId });
      } catch (error) {
        ctx.logger.error("Payroll issue update failed", { issueId: event.entityId, error: errorMessage(error) });
      }
    });
    ctx.events.on(LEDGER_RESULT_EVENT, async (event: PluginEvent) => {
      try {
        await onLedgerResult(e, event.companyId, event.payload);
      } catch (error) {
        ctx.logger.error("Payroll ledger result failed", { error: errorMessage(error) });
      }
    });
    ctx.events.on(MAIL_RESULT_EVENT, async (event: PluginEvent) => {
      try {
        await onMailResult(e, event.companyId, event.payload);
      } catch (error) {
        ctx.logger.error("Payroll mail result failed", { error: errorMessage(error) });
      }
    });
    ctx.events.on("company.created", async (event: PluginEvent) => {
      if (event.companyId) await skills?.ensure(event.companyId);
    });

    // Outbox redelivery keeps running for companies that switched Payroll off, so queued work is not stranded.
    ctx.jobs.register("redeliver", () =>
      trackJob(ctx, "redeliver", async () => {
        const result = await redeliver(ctx);
        if (result.emitted || result.failed) ctx.logger.info("Payroll outbox redelivered", result);
      }),
    );
    ctx.jobs.register("follow-up", () => trackJob(ctx, "follow-up", () => followUp(e, onLinked)));
    ctx.logger.info("Payroll plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Payroll plugin ready" };
  },
  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!env) return { status: 503, body: { error: "Payroll plugin is not ready" } };
    if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) {
      try {
        return { status: 200, body: await setupStatus(env, input.companyId) };
      } catch (error) {
        return { status: 500, body: { error: errorMessage(error) } };
      }
    }
    if (input.routeKey === COCKPIT_ROUTE.routeKey) {
      if (!input.companyId) return { status: 400, body: { error: "companyId is required" } };
      try {
        return { status: 200, body: await cockpitSnapshot(env, input.companyId) };
      } catch (error) {
        return { status: 500, body: { error: errorMessage(error) } };
      }
    }
    return { status: 404, body: { error: "Unknown route" } };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

function statusOf(payload: unknown): string | undefined {
  const status = payload && typeof payload === "object" ? (payload as Record<string, unknown>).status : undefined;
  return typeof status === "string" ? status : undefined;
}

// ---------------------------------------------------------------------------
// Page actions
// ---------------------------------------------------------------------------

function registerActions(e: Env, onLinked: ReturnType<typeof clerkOnLinked>) {
  const { ctx } = e;
  const action = (key: string, fn: (companyId: string, actor: Actor, params: Record<string, unknown>) => Promise<unknown>) =>
    ctx.actions.register(key, async (params, context: PluginPerformActionContext) => {
      if (!context.companyId) throw new PayrollError("Open Payroll inside a company");
      void skills?.ensure(context.companyId);
      return fn(context.companyId, actionActor(context), asParams(params));
    });

  action("payroll.load", async (companyId, actor, params) => {
    // The page reports /_plugins/<installation uuid>/ui/ so Setup can link to the settings page.
    await rememberPluginUiBase(ctx, params.uiBase);
    const me = actor.kind === "user" ? actor.userId : null;
    await tryLinkPendingHire(ctx, companyId, CLERK_ROLE, onLinked).catch(() => null);
    const date = today(e);
    const [data, employees, terms, recurring, runs, custom, hire, reviewed] = await Promise.all([
      overview(e, companyId, true, me),
      db.listEmployees(ctx, companyId),
      db.termsOn(ctx, companyId, "9999-12-31"),
      db.listRecurring(ctx, companyId),
      db.listRuns(ctx, companyId, 60),
      db.listCustomComponents(ctx, companyId),
      hireStatus(ctx, companyId, CLERK_ROLE).catch(() => null),
      rulesReviewed(e, companyId),
    ]);
    return {
      ...data,
      rulesReviewed: reviewed,
      me,
      employees: employees.map((x) => employeeView(x, terms.get(x.id) ?? null, recurring.filter((r) => r.employeeId === x.id), date)),
      runs: runs.map(runSummary),
      components: mergeComponents(custom),
      hire,
    };
  });

  action("payroll.review-rules", (companyId, actor) => markRulesReviewed(e, companyId, actor));
  action("payroll.rules", async (_companyId, _actor, params) => rulesView(e, optStr(params, "taxYear", 7) ?? taxYearOf(today(e))));
  action("payroll.employee-terms", async (companyId, _actor, params) => ({ terms: (await db.listTerms(ctx, companyId, reqStr(params, "employeeId", 64))).map(termsView) }));
  action("payroll.save-employee", (companyId, actor, params) => saveEmployee(e, companyId, actor, params));
  action("payroll.terminate-employee", (companyId, actor, params) => terminateEmployee(e, companyId, actor, params));
  action("payroll.save-terms", (companyId, actor, params) => saveTerms(e, companyId, actor, params));
  action("payroll.set-recurring", (companyId, actor, params) => setRecurring(e, companyId, actor, params));
  action("payroll.save-component", (companyId, actor, params) => saveComponent(e, companyId, actor, params));
  action("payroll.reveal", (companyId, actor, params) => revealEmployeeField(e, companyId, actor, params));

  action("payroll.run", async (companyId, _actor, params) => runDetail(e, companyId, reqStr(params, "runId", 64)));
  action("payroll.create-run", async (companyId, actor, params) => {
    requireUser(actor);
    return createRun(e, companyId, actor, params);
  });
  action("payroll.calculate-run", (companyId, actor, params) => calculateRun(e, companyId, actor, params));
  action("payroll.adjust-item", (companyId, actor, params) => adjustItem(e, companyId, actor, params));
  action("payroll.request-approval", async (companyId, actor, params) => {
    requireUser(actor);
    return requestApproval(e, companyId, actor, params);
  });
  action("payroll.approve-run", (companyId, actor, params) => approveRun(e, companyId, actor, params));
  action("payroll.reject-run", (companyId, actor, params) => rejectRun(e, companyId, actor, params));
  action("payroll.lock-run", async (companyId, actor, params) => {
    const locked = await lockRun(e, companyId, actor, params);
    const run = await requireRun(e, companyId, locked.runId);
    let payslips: { created: number; skipped: string | null } = { created: 0, skipped: null };
    try {
      payslips = await generatePayslips(e, companyId, run.id);
      const config = await e.config(companyId);
      if (config.payslipEmail.sendOnLock && !payslips.skipped) await queuePayslipEmails(e, companyId, run, null);
    } catch (error) {
      payslips = { created: 0, skipped: errorMessage(error) };
    }
    return { ...locked, payslips };
  });
  action("payroll.reverse-run", async (companyId, actor, params) => {
    requireUser(actor);
    return reverseRun(e, companyId, actor, params);
  });
  action("payroll.correct-run", async (companyId, actor, params) => {
    requireUser(actor);
    return correctRun(e, companyId, actor, params);
  });
  action("payroll.cancel-run", (companyId, actor, params) => cancelRun(e, companyId, actor, params));
  action("payroll.repost-ledger", (companyId, actor, params) => repostLedger(e, companyId, actor, params));
  action("payroll.variances", (companyId, _actor, params) => runVariances(e, companyId, params));

  action("payroll.payslips", async (companyId, _actor, params) => {
    const runId = optStr(params, "runId", 64) ?? undefined;
    const [slips, employees, runs] = await Promise.all([db.listPayslips(ctx, companyId, runId), db.listEmployees(ctx, companyId), db.listRuns(ctx, companyId, 200)]);
    const names = new Map(employees.map((x) => [x.id, x.name]));
    const runNumbers = new Map(runs.map((r) => [r.id, { number: r.number, payDate: r.payDate }]));
    return {
      payslips: slips.map((p) => ({
        id: p.id,
        number: p.number,
        runId: p.runId,
        run: runNumbers.get(p.runId)?.number ?? null,
        payDate: runNumbers.get(p.runId)?.payDate ?? null,
        employee: names.get(p.employeeId) ?? null,
        status: p.status,
        emailedTo: p.emailedTo,
        emailedAt: p.emailedAt,
        error: p.error,
      })),
    };
  });
  action("payroll.generate-payslips", async (companyId, actor, params) => {
    requireUser(actor);
    return generatePayslips(e, companyId, reqStr(params, "runId", 64));
  });
  action("payroll.email-payslips", (companyId, actor, params) => emailPayslips(e, companyId, actor, params));
  action("payroll.download-payslip", (companyId, actor, params) => payslipDownload(e, companyId, actor, params));

  action("payroll.net-pay-file", (companyId, actor, params) => netPayFile(e, companyId, actor, params));
  action("payroll.emp201", (companyId, _actor, params) => emp201(e, companyId, params));
  action("payroll.certificates", async (companyId, _actor, params) => {
    const taxYear = optStr(params, "taxYear", 7) ?? taxYearOf(today(e));
    const { certificates: certs } = await certificates(e, companyId, taxYear, false);
    return { taxYear, certificates: certs };
  });
  action("payroll.emp501", (companyId, _actor, params) => emp501(e, companyId, params));
  action("payroll.export", (companyId, actor, params) => exportStatutory(e, companyId, actor, params));
  action("payroll.download-export", (companyId, actor, params) => exportDownload(e, companyId, actor, params));
  action("payroll.exports", async (companyId) => ({ exports: await db.listExports(ctx, companyId) }));
  action("payroll.import-ytd", (companyId, actor, params) => importYtd(e, companyId, actor, params));
  action("payroll.audit", async (companyId, actor) => {
    requireUser(actor);
    return { audit: await db.listAudit(ctx, companyId, 100) };
  });

  action("payroll.leave", (companyId, _actor, params) => leaveOverview(e, companyId, params));
  action("payroll.request-leave", (companyId, actor, params) => requestLeave(e, companyId, actor, params));
  action("payroll.decide-leave", (companyId, actor, params) => decideLeave(e, companyId, actor, params));
  action("payroll.cancel-leave", (companyId, actor, params) => cancelLeave(e, companyId, actor, params));
  action("payroll.leave-opening", (companyId, actor, params) => setLeaveOpening(e, companyId, actor, params));

  // Hiring the optional Payroll Clerk (kit agent-hire).
  action("payroll.hire-options", async (companyId, actor) => {
    requireUser(actor);
    const [agents, status] = await Promise.all([listCompanyAgents(ctx, companyId), hireStatus(ctx, companyId, CLERK_ROLE)]);
    return { draft: hireTaskDraft(CLERK_ROLE), agents, defaultAssigneeAgentId: agents.find((a) => a.role === "ceo")?.id ?? null, status };
  });
  action("payroll.start-hire", async (companyId, actor, params) => {
    const user = requireUser(actor);
    const assigneeAgentId = optStr(params, "assigneeAgentId", 64);
    if (assigneeAgentId && !(await ctx.agents.get(assigneeAgentId, companyId))) throw new PayrollError("That assignee is not an agent in this company");
    const hire = await startHire(ctx, companyId, CLERK_ROLE, {
      title: optStr(params, "title", 250) ?? undefined,
      description: optStr(params, "description", 50_000) ?? undefined,
      assigneeAgentId,
      assigneeUserId: assigneeAgentId ? null : assignableUser(optStr(params, "assigneeUserId", 64)),
      actorUserId: assignableUser(user.userId),
    });
    return { hire };
  });
  action("payroll.link-agent", async (companyId, actor, params) => {
    const user = requireUser(actor);
    return linkAgent(ctx, companyId, CLERK_ROLE, reqStr(params, "agentId", 64), { by: "manual", userId: user.userId, onLinked });
  });
  action("payroll.unlink-agent", async (companyId, actor) => {
    requireUser(actor);
    await unlinkAgent(ctx, companyId, CLERK_ROLE);
    return { status: await hireStatus(ctx, companyId, CLERK_ROLE) };
  });
  action("payroll.sync-skills", async (companyId, actor) => {
    requireUser(actor);
    return { results: await skills?.force(companyId) };
  });
}


