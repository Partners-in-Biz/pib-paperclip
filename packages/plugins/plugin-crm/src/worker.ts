import { randomUUID } from "node:crypto";
import { APPROVAL_EVENT, onApprovalEvent, onSignoffEvent, SIGNOFF_EVENT } from "./site-signoff.js";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  clientScopeFromInput,
  COCKPIT_ROUTE,
  createSkillSyncer,
  createWorkIssue,
  isModuleEnabled,
  linkAgent,
  MAIL_EVENTS,
  normalizeToolResult,
  PIB_PLUGINS,
  pluginEvent,
  publishCockpitSnapshot,
  readConfig,
  checkDoneOnUpdate,
  registerHireWatch,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  SETUP_STATUS_ROUTE,
  startHire,
  trackJob,
  unlinkAgent,
  type ClientRef,
} from "@partnersinbiz/pib-plugin-kit";
import {
  accountManager,
  ACCOUNT_MANAGER_ROLE,
  CRM_HIRE_ROLES,
  crmRoleOf,
  onRoleLinked,
  roleAgent,
  hireOptions,
  hireView,
  onAccountManagerLinked,
  tryLinkAccountManager,
  wireAgent,
} from "./agent.js";
import { asRecord, asStringList, table } from "./db.js";
import { runSalesDaily, runSalesWeekly } from "./sales.js";
import {
  contactCompanyLinks,
  defineField,
  dueEnrollments,
  enrollmentByIssue,
  deleteSavedView,
  findDuplicateContacts,
  insertDealProduct,
  listDealProducts,
  insertSavedView,
  listSavedViews,
  mergeContacts,
  enrollmentsForContact,
  enrollmentsForSequence,
  ensurePipeline,
  getAccount,
  getContact,
  getDeal,
  getSequence,
  getStage,
  grantsFor,
  insertAccount,
  insertActivity,
  insertContact,
  insertDeal,
  insertEnrollment,
  insertFacts,
  insertGrant,
  insertLink,
  insertSequence,
  insertStep,
  listAccounts,
  listActivities,
  listFacts,
  listContacts,
  listDeals,
  listLinks,
  listProducts,
  listSequences,
  listStages,
  listSteps,
  contactEngagement,
  getProduct,
  insertProduct,
  saveProduct,
  saveAccount,
  saveContact,
  companiesByDomainOrName,
  contactsByEmail,
  contactsByPhone,
  saveDeal,
  saveEnrollment,
  stageKind,
  stopEnrollmentsForContact,
  sequenceDelivery,
  sequenceEmailApproved,
  recordDates,
} from "./db.js";
import { crmSeries } from "./series.js";
import {
  advanceEnrollment,
  applyFieldPatch,
  assertActivityKind,
  assertCanEmail,
  assertDelivery,
  assertAmountMinor,
  assertCurrency,
  assertFieldType,
  assertMergeTargets,
  assertProductName,
  forecastPipeline,
  createSavedView,
  normalizeEmail,
  normalizeEmails,
  normalizeDomain,
  normalizeBillingField,
  BILLING_KEYS,
  phoneMatchKey,
  fillContact,
  duplicateGroups,
  type ContactFill,
  parseCsv,
  personalize,
  toCsv,
  assertLifecycle,
  assertNextAction,
  assertPrincipalType,
  assertRecordType,
  assertSharePrincipal,
  canSeeRecord,
  columnKeysFor,
  createAccount,
  createContact,
  createDealProduct,
  createProduct,
  CrmError,
  EMAIL_STATUSES,
  scoreBand,
  scoreContact,
  linkContact,
  LOCAL_BOARD_USER_ID,
  requireVisible,
  sequenceIssueCopy,
  startEnrollment,
  type AccountDraft,
  type CompletionMode,
  type ContactDraft,
  type DealDraft,
  type EmailStatus,
  type ProductDraft,
  type RecordType,
  type SequenceStepDraft,
  type Viewer,
} from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { CRM_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { CRM_MUTATIONS, crmCompanyIds, emitChanges, emitContactDeleted, touchContact } from "./sync.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import {
  deleteCompanyRecord,
  INVOICE_PAID_EVENT,
  moveDealTo,
  moveToWonWith,
  onDealWon,
  onContactSuppressed,
  onInvoicePaid,
  onQuoteAccepted,
  QUOTE_ACCEPTED_EVENT,
  reemitHandoffs,
  setEmailStatus,
  SUPPRESSION_EVENTS,
  withQuote,
} from "./handoffs.js";
import { closeStands, CRM_DONE_CHECKS, doneCheckIssue } from "./done-checks.js";
import { originFor } from "./origins.js";
import { LEAD_EVENTS, onLeadCaptured, processHeldLeads } from "./leads.js";
import { clientLeadForms, createLeadEndpoint, handleLeadWebhook, listLeadSourcesTool, makeLeadSecret, retryClientLeadIssues, rotateLeadKey, updateLeadSource } from "./lead-capture.js";
import { purgeHits } from "./lead-store.js";
import { purgePublicHits } from "./esign-store.js";
import { dayOf, ROLLUP_KEEP_DAYS } from "./site-events-form.js";
import { purgeRollup } from "./site-events-store.js";
import { cleanupCanary, ensureCanaryClient } from "./canary.js";
import { onCareApprovalIssue, onCareSendResult } from "./care-approvals.js";
import { CARE_TOOL_NAMES, clientCareView, isCareTool, runCareTool } from "./care-dispatch.js";
import { ESIGN_PERSON_ACTIONS, ESIGN_TOOL_NAMES, isEsignTool, runEsignTool } from "./esign-dispatch.js";
import { EVENTS_ENDPOINT_KEY, SIGN_ENDPOINT_KEY } from "./endpoints.js";
import { handleSignWebhook } from "./esign-public.js";
import { GROWTH_TOOL_NAMES, isGrowthTool, runGrowthTool } from "./growth-dispatch.js";
import { clientAgreementsAndGrowth } from "./growth-view.js";
import { handleEventsWebhook } from "./site-events.js";
import { syncAllPages } from "./esign-sync.js";
import { onMailForCare, runClientCareJob, runClientHealthJob, runMonthlyReportJob, runSiteMonitorJob } from "./care-jobs.js";
import { registerClientSignals } from "./client-signals.js";
import { registerPrivacy } from "./privacy.js";
import { reemitSensitivity, sensitivityOf } from "./register.js";
import { onReplyIssueUpdated } from "./support.js";
import { startNewClient } from "./new-client.js";
import { backfillServices, onServiceStepIssue, runServicesCheck } from "./service-onboarding.js";
import {
  findRecords,
  getClientProfileTool,
  getCompany as getCompanyTool,
  getContact as getContactTool,
  listDealsTool,
  listSequencesTool,
  listStagesTool,
  parseClientRef,
  pickProfile,
  updateClientProfile,
} from "./lookup.js";
import { companyPrefix, crmLink, refOf } from "./refs.js";
import { contactAssignee } from "./mail.js";
import { publishAllSetupStatus, recordFullShare, rememberCompany, setupStatus } from "./setup-status.js";
import { getClientProfile, handoffCompanies, heldLeadStats, listClientLeads } from "./store.js";
import {
  ensureApprovalOpen,
  onApprovalIssue,
  onMailReceived,
  onSendResult,
  redeliverMail,
  scoreLead,
  scoreLeadLater,
  sendSequenceStep,
  setDelivery,
} from "./mail.js";
import { jevConfigFor } from "./jev.js";
import {
  checkClientSite,
  clientSitesAndProjects,
  connectClientSite,
  deleteClientSite,
  emitSites,
  linkClientProject,
  listClientProjectsTool,
  listClientSitesTool,
  refreshSite,
  runWpTool,
  saveClientSite,
  siteChangesTool,
  staleConnectorSites,
  unlinkClientProject,
  WP_TOOL_NAMES,
} from "./sites.js";

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

/** Syncs the CRM skills for a company (always resolves; failures are logged by the kit). */
const syncSkills = async (companyId: string) => (skillSync ? skillSync.force(companyId) : []);

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);
    // What the other modules say about a client (for the report and the health score), and the erasure and consent hand-offs.
    registerClientSignals(ctx);
    registerPrivacy(ctx);
    const registerAction = (
      key: string,
      handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>,
    ) => {
      ctx.actions.register(key, async (params, context) => {
        if (context.companyId) await skillSync?.ensure(context.companyId).catch(() => undefined);
        const result = await handler(params, context);
        if (context.companyId && CRM_MUTATIONS.has(key)) await afterMutation(ctx, context.companyId, key, params);
        return result;
      });
    };
    for (const tool of CRM_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => normalizeToolResult(await runTool(ctx, tool.name, params, run)));
    }
    registerAction("crm.load", async (params, context) => {
      // The page reports /_plugins/<installation uuid>/ui/ so Setup can link the settings page.
      await rememberPluginUiBase(ctx, params.uiBase);
      if (context.companyId) await rememberCompany(ctx, context.companyId);
      if (context.companyId && context.actor.type === "user") await tryLinkAccountManager(ctx, context.companyId, syncSkills);
      return load(ctx, context);
    });
    registerAction("crm.client-workspace", (params, context) => clientWorkspaceAction(ctx, context, params));
    registerAction("crm.create-company", (params, context) => createCompanyAction(ctx, context, params));
    registerAction("crm.update-company", (params, context) => updateCompanyAction(ctx, context, params));
    registerAction("crm.delete-company", (params, context) => deleteCompanyAction(ctx, context, params));
    registerAction("crm.create-contact", (params, context) => createContactAction(ctx, context, params));
    registerAction("crm.update-contact", (params, context) => updateContactAction(ctx, context, params));
    registerAction("crm.set-email-status", (params, context) => emailStatusAction(ctx, context, params));
    registerAction("crm.update-client-profile", async (params, context) => updateClientProfile(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.link-contact", (params, context) => linkAction(ctx, context, params));
    registerAction("crm.create-deal", (params, context) => createDealAction(ctx, context, params));
    registerAction("crm.move-deal", (params, context) => moveDealAction(ctx, context, params));
    registerAction("crm.update-deal", async (params, context) => updateDealRecord(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.sequence-detail", async (params, context) => sequenceDetail(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.log-activity", (params, context) => activityAction(ctx, context, params));
    registerAction("crm.share-record", (params, context) => shareAction(ctx, context, params));
    registerAction("crm.set-human-owned", (params, context) => humanOwnedAction(ctx, context, params));
    registerAction("crm.create-sequence", (params, context) => createSequenceAction(ctx, context, params));
    registerAction("crm.enroll", (params, context) => enrollAction(ctx, context, params));
    registerAction("crm.create-product", (params, context) => createProductAction(ctx, context, params));
    registerAction("crm.update-product", (params, context) => updateProductAction(ctx, context, params));
    registerAction("crm.score-contact", (params, context) => scoreContactAction(ctx, context, params));
    registerAction("crm.activities", (params, context) => activitiesAction(ctx, context, params));
    registerAction("crm.resync", (_params, context) => resyncAction(ctx, context));
    registerAction("crm.sync-skills", (_params, context) => syncSkillsAction(ctx, context));
    registerAction("crm.settings-status", (_params, context) => settingsStatusAction(ctx, context));
    // Websites and projects on the client page.
    registerAction("crm.save-client-site", async (params, context) => saveClientSite(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.delete-client-site", async (params, context) => deleteClientSite(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.connect-client-site", async (params, context) => connectClientSite(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.check-client-site", async (params, context) => checkClientSite(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.site-changes", async (params, context) => siteChangesTool(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.link-client-project", async (params, context) => linkClientProject(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.unlink-client-project", async (params, context) => unlinkClientProject(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.set-sequence-delivery", async (params, context) => setSequenceDelivery(ctx, await actionViewer(ctx, context), params));
    // Lead forms (public lead capture), starting a new client, and the canary client.
    registerAction("crm.create-lead-endpoint", async (params, context) => createLeadEndpoint(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.rotate-lead-key", async (params, context) => rotateLeadKey(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.make-lead-secret", async (params, context) => makeLeadSecret(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.list-lead-sources", async (params, context) => listLeadSourcesTool(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.update-lead-source", async (params, context) => updateLeadSource(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.start-new-client", async (params, context) => startNewClient(ctx, await actionViewer(ctx, context), params, actionSource(context)));
    registerAction("crm.find-records", async (params, context) => findRecords(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.create-canary-client", async (params, context) => ensureCanaryClient(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.cleanup-canary", async (params, context) => cleanupCanary(ctx, await actionViewer(ctx, context), params));
    registerAction("crm.run-services-check", async (_params, context) => runServicesCheck(ctx, new Date(), { companyId: requireCompany(context) }));
    registerAction("crm.normalize-services", async (_params, context) => ({ saved: await backfillServices(ctx, requireCompany(context)) }));
    // Client care (reports, support, client requests, monitoring, privacy): every care tool is also a page action, `crm.<tool name>`.
    for (const name of CARE_TOOL_NAMES) {
      registerAction(`crm.${name}`, async (params, context) => runCareTool(ctx, await actionViewer(ctx, context), name, objectParams(params), actionSource(context)));
    }

    // Website tools (wp-seo, wp-content, wp-redirects and the rest): also page actions `crm.<tool name>`, so a person can
    // change a site the agents are locked out of. The source is "human" for a board user, so the sign-off lock (which only
    // refuses agents) lets it through; every write still needs a reason and is logged in site_changes with the actor.
    for (const name of WP_TOOL_NAMES) {
      registerAction(`crm.${name}`, async (params, context) => runWpTool(ctx, await actionViewer(ctx, context), name, objectParams(params), actionSource(context)));
    }

    // E-sign: every tool is also a page action `crm.<tool name>`; turning it on for a client is a person's action only.
    for (const name of [...ESIGN_TOOL_NAMES, ...ESIGN_PERSON_ACTIONS]) {
      registerAction(`crm.${name}`, async (params, context) => runEsignTool(ctx, await actionViewer(ctx, context), name, objectParams(params), actionSource(context)));
    }

    // Attribution and site events: every tool is also a page action `crm.<tool name>` (`crm.attribution-report` and the rest).
    for (const name of GROWTH_TOOL_NAMES) {
      registerAction(`crm.${name}`, async (params, context) => runGrowthTool(ctx, await actionViewer(ctx, context), name, objectParams(params), actionSource(context)));
    }

    // The CRM's roles (Setup → Team calls these; kit TEAM_ROLES "account-manager" and the sales roles, picked by `params.role`).
    registerAction("crm.hire-options", async (params, context) => {
      const role = crmRoleOf(params);
      requireUser(context, `hire the ${role.displayName}`);
      return hireOptions(ctx, requireCompany(context), role);
    });
    registerAction("crm.start-hire", async (params, context) => {
      const role = crmRoleOf(params);
      const userId = requireUser(context, `hire the ${role.displayName}`);
      return {
        hire: await startHire(ctx, requireCompany(context), role, {
          title: optionalString(params, "title"),
          description: optionalString(params, "description"),
          assigneeAgentId: optionalString(params, "assigneeAgentId") ?? null,
          assigneeUserId: optionalString(params, "assigneeUserId") ?? null,
          actorUserId: userId,
        }),
      };
    });
    registerAction("crm.link-agent", async (params, context) => {
      const role = crmRoleOf(params);
      const userId = requireUser(context, `link the ${role.displayName}`);
      const companyId = requireCompany(context);
      let wired: Awaited<ReturnType<typeof wireAgent>> | null = null;
      const { agent, steps } = await linkAgent(ctx, companyId, role, requiredString(params, "agentId"), {
        by: "manual",
        userId,
        onLinked: async (c, agentId, by) => {
          wired = await wireAgent(ctx, c, agentId, by.userId, syncSkills, role);
          return wired.steps;
        },
      });
      return { agent, steps, instructions: (wired as { instructions?: string[] } | null)?.instructions ?? [] };
    });
    registerAction("crm.unlink-agent", async (params, context) => {
      const role = crmRoleOf(params);
      requireUser(context, `unlink the ${role.displayName}`);
      await unlinkAgent(ctx, requireCompany(context), role);
      return { ok: true };
    });
    registerAction("crm.resync-agent", async (params, context) => {
      const role = crmRoleOf(params);
      const userId = requireUser(context, `re-sync the ${role.displayName}`);
      const companyId = requireCompany(context);
      const agent = await roleAgent(ctx, companyId, role);
      if (!agent) throw new CrmError(`No ${role.displayName} is linked yet. Hire one or pick an agent you already have in Setup → Team.`);
      return wireAgent(ctx, companyId, agent.id, userId, syncSkills, role);
    });
    registerHireWatch(ctx, Object.values(CRM_HIRE_ROLES).map((role) => ({ role, onLinked: onRoleLinked(ctx, syncSkills, role) })));

    ctx.jobs.register("open-due-steps", () => trackJob(ctx, "open-due-steps", () => openDueSteps(ctx)));
    ctx.jobs.register("redeliver-mail", async () => {
      await trackJob(ctx, "redeliver-mail", async () => {
        const result = await redeliverMail(ctx);
        if (result.emitted || result.failed || result.handedOver) ctx.logger.info("CRM mail redelivery", result);
      });
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.seo, SIGNOFF_EVENT), (event) => onSignoffEvent(ctx, event).catch((error) => ctx.logger.info("CRM sign-off event failed", { error: String(error) })));
    ctx.events.on(pluginEvent(PIB_PLUGINS.seo, APPROVAL_EVENT), (event) => onApprovalEvent(ctx, event).catch((error) => ctx.logger.info("CRM approval event failed", { error: String(error) })));
    ctx.jobs.register("held-leads", async () => {
      await trackJob(ctx, "held-leads", async () => {
        const result = await processHeldLeads(ctx);
        if (result.processed || result.failed) ctx.logger.info("CRM held leads", result);
        const clientIssues = await retryClientLeadIssues(ctx);
        if (clientIssues) ctx.logger.info("CRM client lead issues opened", { opened: clientIssues });
      });
    });
    ctx.jobs.register("services-check", async () => {
      await trackJob(ctx, "services-check", async () => {
        const result = await runServicesCheck(ctx);
        if (result.opened || result.backfilled || result.started) ctx.logger.info("CRM services check", result);
      });
    });
    ctx.jobs.register("site-monitor", async () => {
      await trackJob(ctx, "site-monitor", async () => {
        const result = await runSiteMonitorJob(ctx);
        if (result.down) ctx.logger.info("CRM site monitor", { ...result });
      });
    });
    ctx.jobs.register("client-care", async () => {
      await trackJob(ctx, "client-care", async () => {
        const result = await runClientCareJob(ctx);
        if (result.breaches || result.reminders || result.settled || result.reports) ctx.logger.info("CRM client care", { ...result });
      });
    });
    ctx.jobs.register("client-health", async () => {
      await trackJob(ctx, "client-health", async () => {
        const result = await runClientHealthJob(ctx);
        if (result.alerts) ctx.logger.info("CRM client health", { ...result });
      });
    });
    ctx.jobs.register("client-report-monthly", async () => {
      await trackJob(ctx, "client-report-monthly", async () => {
        const result = await runMonthlyReportJob(ctx);
        ctx.logger.info("CRM monthly client reports", { ...result });
      });
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.received), async (event) => {
      // Replies are ignored while the CRM module is switched off for the company.
      if (event.companyId && !(await isModuleEnabled(ctx, event.companyId, PLUGIN_ID))) return;
      await onMailReceived(ctx, event);
      // A reply to one of our client emails, or a support request that becomes a case.
      await onMailForCare(ctx, event);
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult), (event) => onSendResult(ctx, event));
    // The Mailbox's answer for an approved email to a client (keys crm:msg:...); sequence emails (crm:seq:...) are handled above.
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult), (event) => onCareSendResult(ctx, event));
    ctx.jobs.register("emit-recent", () => trackJob(ctx, "emit-recent", () => emitForAllCompanies(ctx, 1800)));
    ctx.jobs.register("emit-all", () => trackJob(ctx, "emit-all", () => emitForAllCompanies(ctx, null)));
    ctx.jobs.register("sales-daily", async () => {
      await trackJob(ctx, "sales-daily", async () => {
        const result = await runSalesDaily(ctx);
        if (result.pipeline || result.duplicates) ctx.logger.info("CRM sales daily", result);
      });
    });
    ctx.jobs.register("sales-weekly", async () => {
      await trackJob(ctx, "sales-weekly", async () => {
        const result = await runSalesWeekly(ctx);
        if (result.summaries || result.hygiene) ctx.logger.info("CRM sales weekly", result);
      });
    });
    ctx.jobs.register("setup-status", async () => {
      await trackJob(ctx, "setup-status", async () => {
        // First, so a failing step below can never leave the lead form's request log to grow.
        await purgeHits(ctx, new Date(Date.now() - 2 * 86_400_000).toISOString()).catch(() => undefined);
        // The signing page's and the site events' request logs (keyed address hashes), and daily counts past their retention.
        await purgePublicHits(ctx, new Date(Date.now() - 2 * 86_400_000).toISOString()).catch(() => undefined);
        await purgeRollup(ctx, dayOf(Date.now() - ROLLUP_KEEP_DAYS * 86_400_000)).catch(() => undefined);
        await linkPendingHires(ctx);
        await reemitAllHandoffs(ctx);
        await publishAllSetupStatus(ctx);
        await publishAllCockpit(ctx);
        await refreshStaleSites(ctx);
      });
    });
    // Leads handed over by Social (inbox intent) and the Mailbox (mail triaged as a lead).
    for (const eventType of LEAD_EVENTS) {
      ctx.events.on(eventType, (event) => onLeadCaptured(ctx, event, async (companyId) => publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId))));
    }
    // Sales hand-offs from Billing, and opt-outs from Campaigns and the Mailbox.
    // Both can make a client a customer: share the new lifecycle with the other modules at once.
    ctx.events.on(QUOTE_ACCEPTED_EVENT, async (event) => {
      await onQuoteAccepted(ctx, event, moveToWonWith(ctx));
      if (event.companyId) await afterMutation(ctx, event.companyId, "quote.accepted", {});
    });
    ctx.events.on(INVOICE_PAID_EVENT, async (event) => {
      await onInvoicePaid(ctx, event);
      if (event.companyId) await afterMutation(ctx, event.companyId, "invoice.paid", {});
    });
    for (const eventType of SUPPRESSION_EVENTS) ctx.events.on(eventType, (event) => onContactSuppressed(ctx, event));
    // One subscription (a second would run both twice). Done-checks first, so an agent's
    // early close is reopened before the step handler would move the contact on.
    ctx.events.on("issue.updated", async (event) => {
      await checkDoneOnUpdate(ctx, CRM_DONE_CHECKS, event);
      await onIssueUpdated(ctx, event);
    });
    ctx.events.on("plugin.partnersinbiz.partners.grant.revoked", (event) => onPartnerGrantRevoked(ctx, event.companyId, event.payload));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
    await syncKnownCompanies(ctx);
    // A deploy empties the folder the signing pages live in: write them again from the records (never blocks start).
    void syncAllPages(ctx).catch((error) => ctx.logger.info("CRM signing pages not synced at start", { error: error instanceof Error ? error.message : String(error) }));
    ctx.logger.info("CRM plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "CRM plugin ready" };
  },

  /** The public lead form (`POST /api/plugins/partnersinbiz.crm/webhooks/lead`). Throws a plain message when the sender can fix something. */
  async onWebhook(input) {
    if (!pluginCtx) throw new Error("The form is not ready yet. Please try again in a minute.");
    // Three public endpoints, each checked on its own terms: the lead form, the signing page and (below) the site events.
    if (input.endpointKey === SIGN_ENDPOINT_KEY) {
      await handleSignWebhook(pluginCtx, input);
      return;
    }
    if (input.endpointKey === EVENTS_ENDPOINT_KEY) {
      await handleEventsWebhook(pluginCtx, input);
      return;
    }
    await handleLeadWebhook(pluginCtx, input);
  },

  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "CRM plugin is not ready" } };
    if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) {
      return { status: 200, body: await setupStatus(pluginCtx, input.companyId) };
    }
    if (input.routeKey === COCKPIT_ROUTE.routeKey) {
      return { status: 200, body: await cockpitSnapshot(pluginCtx, input.companyId) };
    }
    return acceptPartnerGrant(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

/** Hourly: link hires that appeared (agent events are at-most-once). */
async function linkPendingHires(ctx: PluginContext): Promise<void> {
  for (const companyId of await crmCompanyIds(ctx).catch(() => [] as string[])) {
    if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
    if (Object.keys(await readConfig(ctx, companyId).catch(() => ({}))).length === 0) continue;
    await tryLinkAccountManager(ctx, companyId, syncSkills);
  }
}

/** Hourly: ping Connector sites not heard from in 6 hours (a few per run), so every module sees a current status. */
async function refreshStaleSites(ctx: PluginContext): Promise<void> {
  for (const site of await staleConnectorSites(ctx, 6, 10).catch(() => [])) {
    try {
      if (Object.keys(await readConfig(ctx, site.companyId)).length === 0) continue;
      await refreshSite(ctx, site, "system:crm-hourly-check");
    } catch (error) {
      ctx.logger.info("CRM site check skipped", { siteId: site.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Hourly: re-send the last day's hand-offs (deal.won, contact.suppressed, deletes). */
async function reemitAllHandoffs(ctx: PluginContext): Promise<void> {
  for (const companyId of await handoffCompanies(ctx, 24).catch(() => [] as string[])) {
    try {
      if (Object.keys(await readConfig(ctx, companyId)).length === 0) continue;
      await reemitHandoffs(ctx, companyId);
    } catch (error) {
      ctx.logger.info("CRM hand-off re-send skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function requireCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CrmError("Open the CRM inside a company");
  return context.companyId;
}

function requireUser(context: PluginPerformActionContext, what: string): string {
  if (context.actor.type !== "user" || !context.actor.userId) throw new CrmError(`Only a board user can ${what}`);
  return context.actor.userId;
}

/** Tools whose result is a company or contact record: agents get its ref and link too. */
const RECORD_TOOLS: Record<string, "company" | "contact"> = {
  "create-company": "company",
  "update-company": "company",
  "create-contact": "contact",
  "update-contact": "contact",
};

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const viewer = await viewerFor(ctx, {
      companyId: run.companyId,
      userId: null,
      agentId: run.agentId,
      runId: run.runId,
    });
    const body = objectParams(params);
    await skillSync?.ensure(run.companyId).catch(() => undefined);
    let data = await dispatch(ctx, viewer, name, body, "agent");
    if (CRM_MUTATIONS.has(name)) await afterMutation(ctx, run.companyId, name, body);
    const kind = RECORD_TOOLS[name];
    if (kind && data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string") {
      const id = (data as { id: string }).id;
      data = { ref: refOf(kind, id), link: crmLink(await companyPrefix(ctx, run.companyId), kind, id), ...(data as Record<string, unknown>) };
    }
    if (data && typeof data === "object" && "refused" in data && Array.isArray(data.refused) && data.refused.length > 0) {
      return { error: `Refused to overwrite human-owned fields: ${data.refused.join(", ")}`, data };
    }
    return { content: toolContent(data), data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "CRM tool failed" };
  }
}

async function dispatch(
  ctx: PluginContext,
  viewer: Viewer,
  name: string,
  body: Record<string, unknown>,
  source: "agent" | "human",
): Promise<unknown> {
  switch (name) {
    case "create-company":
      return createCompany(ctx, viewer, body);
    case "update-company":
      return updateCompany(ctx, viewer, body, source);
    case "create-contact":
      return createContactRecord(ctx, viewer, body);
    case "update-contact":
      return updateContact(ctx, viewer, body, source);
    case "link-contact":
      return linkRecords(ctx, viewer, body);
    case "log-activity":
      return logActivity(ctx, viewer, body);
    case "create-deal":
      return createDeal(ctx, viewer, body);
    case "move-deal":
      return moveDeal(ctx, viewer, body);
    case "update-deal":
      return updateDealRecord(ctx, viewer, body, source);
    case "share-record":
      return shareRecord(ctx, viewer, body);
    case "define-field":
      return defineRecordField(ctx, viewer, body);
    case "create-sequence":
      return createSequence(ctx, viewer, body);
    case "enroll-contact":
      return enroll(ctx, viewer, body);
    case "create-product":
      return createProductRecord(ctx, viewer, body);
    case "update-product":
      return updateProductRecord(ctx, viewer, body);
    case "score-contact":
      return scoreContactRecord(ctx, viewer, body);
    case "find-duplicates":
      return findDuplicates(ctx, viewer);
    case "merge-contacts":
      return mergeContactsRecord(ctx, viewer, body);
    case "create-saved-view":
      return createSavedViewRecord(ctx, viewer, body);
    case "list-saved-views":
      return listSavedViewsRecord(ctx, viewer);
    case "delete-saved-view":
      return deleteSavedViewRecord(ctx, viewer, body);
    case "export-contacts":
      return exportContacts(ctx, viewer);
    case "import-contacts":
      return importContacts(ctx, viewer, body);
    case "field-history":
      return fieldHistory(ctx, viewer, body);
    case "bulk-tag-contacts":
      return bulkTagContacts(ctx, viewer, body);
    case "contact-graph":
      return contactGraph(ctx, viewer, body);
    case "pipeline-forecast":
      return pipelineForecast(ctx, viewer);
    case "add-deal-product":
      return addDealProduct(ctx, viewer, body);
    case "list-deal-products":
      return listDealProductsRecord(ctx, viewer, body);
    case "set-sequence-delivery":
      return setSequenceDelivery(ctx, viewer, body);
    case "find-records":
      return findRecords(ctx, viewer, body);
    case "get-company":
      return getCompanyTool(ctx, viewer, body);
    case "get-contact":
      return getContactTool(ctx, viewer, body);
    case "list-deals":
      return listDealsTool(ctx, viewer, body);
    case "list-stages":
      return listStagesTool(ctx, viewer);
    case "list-sequences":
      return listSequencesTool(ctx, viewer);
    case "get-client-profile": {
      const profile = await getClientProfileTool(ctx, viewer, body);
      // How sensitive the client's data is, and what it must stay off (client care: the data-processing register).
      return { ...profile, sensitivity: await sensitivityOf(ctx, viewer.companyId, parseClientRef(body.client)) };
    }
    case "update-client-profile":
      return updateClientProfile(ctx, viewer, body, source);
    case "set-email-status":
      return setEmailStatusRecord(ctx, viewer, body, source);
    case "list-client-sites":
      return listClientSitesTool(ctx, viewer, body);
    case "save-client-site":
      return saveClientSite(ctx, viewer, body, source);
    case "check-client-site":
      return checkClientSite(ctx, viewer, body);
    case "connect-client-site":
      return connectClientSite(ctx, viewer, body, source);
    case "site-changes":
      return siteChangesTool(ctx, viewer, body);
    case "list-client-projects":
      return listClientProjectsTool(ctx, viewer, body);
    case "link-client-project":
      return linkClientProject(ctx, viewer, body);
    case "create-lead-endpoint":
      return createLeadEndpoint(ctx, viewer, body, source);
    case "rotate-lead-key":
      return rotateLeadKey(ctx, viewer, body, source);
    case "list-lead-sources":
      return listLeadSourcesTool(ctx, viewer, body);
    case "update-lead-source":
      return updateLeadSource(ctx, viewer, body, source);
    case "start-new-client":
      return startNewClient(ctx, viewer, body, source);
    case "create-canary-client":
      return ensureCanaryClient(ctx, viewer, body);
    case "cleanup-canary":
      return cleanupCanary(ctx, viewer, body);
    default:
      if (WP_TOOL_NAMES.includes(name)) return runWpTool(ctx, viewer, name, body, source);
      if (isCareTool(name)) return runCareTool(ctx, viewer, name, body, source);
      if (isEsignTool(name)) return runEsignTool(ctx, viewer, name, body, source);
      if (isGrowthTool(name)) return runGrowthTool(ctx, viewer, name, body, source);
      throw new CrmError(`Unknown CRM tool ${name}`);
  }
}

/** Every company, contact, deal and link this viewer may see, plus the pipeline. */
async function visibleRecords(ctx: PluginContext, viewer: Viewer) {
  const pipeline = await ensurePipeline(ctx, viewer.companyId);
  const [accounts, contacts, deals, links, sequences, stages] = await Promise.all([
    listAccounts(ctx, viewer.companyId),
    listContacts(ctx, viewer.companyId),
    listDeals(ctx, viewer.companyId),
    listLinks(ctx, viewer.companyId),
    listSequences(ctx, viewer.companyId),
    listStages(ctx, pipeline.pipelineId),
  ]);
  const [accountGrants, contactGrants, dealGrants] = await Promise.all([
    grantsFor(ctx, "company", viewer.companyId),
    grantsFor(ctx, "contact", viewer.companyId),
    grantsFor(ctx, "deal", viewer.companyId),
  ]);
  const visibleAccounts = accounts.filter((row) => canSeeRecord(viewer, row, accountGrants.get(row.id) ?? []));
  const visibleContacts = contacts.filter((row) => canSeeRecord(viewer, row, contactGrants.get(row.id) ?? []));
  const visibleDeals = deals.filter((row) => canSeeRecord(viewer, row, dealGrants.get(row.id) ?? []));
  const contactIds = new Set(visibleContacts.map((row) => row.id));
  const visibleLinks = links.filter((link) => contactIds.has(link.contactId));
  return { pipeline, visibleAccounts, visibleContacts, visibleDeals, visibleLinks, sequences, stages };
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const [records, products] = await Promise.all([
    visibleRecords(ctx, viewer),
    listProducts(ctx, viewer.companyId),
  ]);
  const { visibleAccounts, visibleContacts, visibleDeals, visibleLinks, sequences, stages } = records;

  const linkedContactIds = new Set(visibleLinks.map((link) => link.contactId));
  const openStageIds = new Set(stages.filter((stage) => stage.kind === "open").map((stage) => stage.id));
  const openDeals = visibleDeals.filter((deal) => openStageIds.has(deal.stageId));
  const openPipelineByCurrency: Record<string, number> = {};
  for (const deal of openDeals) {
    openPipelineByCurrency[deal.currency] = (openPipelineByCurrency[deal.currency] ?? 0) + deal.amountMinor;
  }

  const byStage: Record<string, { count: number; amountMinor: number }> = {};
  for (const stage of stages) byStage[stage.id] = { count: 0, amountMinor: 0 };
  for (const deal of visibleDeals) {
    const bucket = byStage[deal.stageId] ?? { count: 0, amountMinor: 0 };
    bucket.count += 1;
    bucket.amountMinor += deal.amountMinor;
    byStage[deal.stageId] = bucket;
  }

  const accountLifecycle: Record<string, number> = {};
  for (const account of visibleAccounts) {
    accountLifecycle[account.lifecycle] = (accountLifecycle[account.lifecycle] ?? 0) + 1;
  }
  const contactLifecycle: Record<string, number> = {};
  for (const contact of visibleContacts) {
    contactLifecycle[contact.lifecycle] = (contactLifecycle[contact.lifecycle] ?? 0) + 1;
  }

  const settingsSaved = Object.keys(await readConfig(ctx, viewer.companyId).catch(() => ({}))).length > 0;
  const [hire, held] = await Promise.all([
    context.actor.type === "user" ? hireView(ctx, viewer.companyId, context.actor.userId ?? null).catch(() => null) : Promise.resolve(null),
    heldLeadStats(ctx, viewer.companyId).catch(() => ({ count: 0, oldest: null })),
  ]);
  const [dealDates, contactDates] = await Promise.all([
    recordDates(ctx, "deals", visibleDeals.map((deal) => deal.id)).catch(() => []),
    recordDates(ctx, "contacts", visibleContacts.map((contact) => contact.id)).catch(() => []),
  ]);
  const series = crmSeries({
    deals: visibleDeals,
    stages,
    dealDates,
    contactDates,
    visibleContactIds: new Set(visibleContacts.map((contact) => contact.id)),
    now: new Date(),
  });
  return {
    settingsSaved,
    hire,
    heldLeads: held.count,
    series,
    accounts: visibleAccounts,
    contacts: visibleContacts,
    deals: visibleDeals,
    links: visibleLinks,
    sequences: sequences.map((row) => ({
      id: row.id,
      name: row.name,
      completionMode: row.completion_mode,
      delivery: sequenceDelivery(row),
      emailApproved: sequenceEmailApproved(row),
      approvalIssueId: row.email_approval_issue_id ?? null,
    })),
    stages: stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      position: stage.position,
      pipelineId: stage.pipeline_id,
    })),
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      unitAmountMinor: product.unitAmountMinor,
      currency: product.currency,
      isActive: product.isActive,
    })),
    summary: {
      companyCount: visibleAccounts.length,
      contactCount: visibleContacts.length,
      dealCount: visibleDeals.length,
      sequenceCount: sequences.length,
      openDealCount: openDeals.length,
      openPipelineByCurrency,
      byStage,
      accountLifecycle,
      contactLifecycle,
      unlinkedContactIds: visibleContacts.filter((contact) => !linkedContactIds.has(contact.id)).map((contact) => contact.id),
      dealsWithoutAmountIds: visibleDeals.filter((deal) => deal.amountMinor <= 0).map((deal) => deal.id),
    },
  };
}

async function createCompanyAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createCompany(ctx, await actionViewer(ctx, context), params);
}

async function createContactAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createContactRecord(ctx, await actionViewer(ctx, context), params);
}

/** A person editing in the UI writes as a human; anything else is held to human-owned fields. */
function actionSource(context: PluginPerformActionContext): "agent" | "human" {
  return context.actor.type === "user" ? "human" : "agent";
}

async function updateCompanyAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return updateCompany(ctx, await actionViewer(ctx, context), params, actionSource(context));
}

async function updateContactAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return updateContact(ctx, await actionViewer(ctx, context), params, actionSource(context));
}

/** A person deletes a company (its people and deals stay). Emits `company.deleted`. */
async function deleteCompanyAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requireUser(context, "delete a company");
  const viewer = await actionViewer(ctx, context);
  const account = await requireAccount(ctx, viewer, companyIdOf(params));
  if (account.companyId !== viewer.companyId) throw new CrmError("Only this workspace's own companies can be deleted");
  if (params.confirm !== account.name && params.confirm !== true) throw new CrmError("Confirm the delete with the company's name");
  return deleteCompanyRecord(ctx, viewer.companyId, account);
}

async function emailStatusAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return setEmailStatusRecord(ctx, await actionViewer(ctx, context), params, actionSource(context));
}

/** Agents may only suppress (unsubscribed or bounced); only a person allows email again. */
async function setEmailStatusRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const status = requiredString(params, "status") as EmailStatus;
  if (!(EMAIL_STATUSES as readonly string[]).includes(status)) throw new CrmError("status must be ok, unsubscribed or bounced");
  if (status === "ok" && source !== "human") throw new CrmError("Only a person can allow email to a contact again");
  const result = await setEmailStatus(ctx, contact, status, { source, note: optionalString(params, "note") ?? null });
  return {
    ...result,
    contact: refOf("contact", contact.id),
    message: status === "ok"
      ? "Email allowed again in the CRM. Campaigns and the Mailbox keep their own opt-out lists."
      : "Sequences stopped. Campaigns and the Mailbox were told not to send marketing email to this address.",
  };
}

async function clientWorkspaceAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return clientWorkspace(ctx, await actionViewer(ctx, context), workspaceRef(params));
}

/** Accepts `{ kind, id }`, `{ client: {kind,id} }` or `{ client: "company:<id>" }`. */
function workspaceRef(params: Record<string, unknown>): ClientRef {
  const fromInput = clientScopeFromInput(params);
  if (fromInput) return fromInput;
  const kind = params.kind;
  const id = typeof params.id === "string" ? params.id.trim() : "";
  if ((kind === "company" || kind === "contact") && id) return { kind, id };
  throw new CrmError("kind (company or contact) and id are required");
}

/**
 * Everything the client workspace Overview shows for one CRM company or
 * contact. An unknown, deleted or hidden id returns `found: false` so the
 * page can show an empty state instead of an error.
 */
async function clientWorkspace(ctx: PluginContext, viewer: Viewer, ref: ClientRef) {
  const records = await visibleRecords(ctx, viewer);
  const { visibleAccounts, visibleContacts, visibleDeals, visibleLinks, sequences, stages } = records;
  const base = { kind: ref.kind, id: ref.id };
  const account = ref.kind === "company" ? visibleAccounts.find((row) => row.id === ref.id) ?? null : null;
  const contact = ref.kind === "contact" ? visibleContacts.find((row) => row.id === ref.id) ?? null : null;
  if (!account && !contact) return { ...base, found: false as const };

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const accountById = new Map(visibleAccounts.map((row) => [row.id, row]));
  const contactById = new Map(visibleContacts.map((row) => [row.id, row]));

  const contacts = account
    ? visibleLinks
      .filter((link) => link.accountId === account.id)
      .flatMap((link) => {
        const row = contactById.get(link.contactId);
        return row ? [{ id: row.id, name: row.name, emails: row.emails, lifecycle: row.lifecycle, roleLabel: link.roleLabel }] : [];
      })
    : [];
  const companies = contact
    ? visibleLinks
      .filter((link) => link.contactId === contact.id)
      .flatMap((link) => {
        const row = accountById.get(link.accountId);
        return row ? [{ id: row.id, name: row.name, domain: row.domain, lifecycle: row.lifecycle, roleLabel: link.roleLabel }] : [];
      })
    : [];

  // A company's deals include those logged against its people without a company set.
  const linkedContactIds = new Set(contacts.map((row) => row.id));
  const deals = visibleDeals
    .filter((deal) => account
      ? deal.accountId === account.id || (deal.accountId == null && deal.contactId != null && linkedContactIds.has(deal.contactId))
      : deal.contactId === contact!.id)
    .map((deal) => ({
      id: deal.id,
      title: deal.title,
      amountMinor: deal.amountMinor,
      currency: deal.currency,
      stageId: deal.stageId,
      stageName: stageById.get(deal.stageId)?.name ?? deal.stageId,
      stageKind: stageById.get(deal.stageId)?.kind ?? "open",
      contactId: deal.contactId,
      contactName: deal.contactId ? contactById.get(deal.contactId)?.name ?? null : null,
      accountId: deal.accountId,
    }));

  const [activities, profileRecord, clientLeads, sitesAndProjects, leadForms, care, agreementsAndGrowth] = await Promise.all([
    listActivities(ctx, ref.kind, ref.id, 50),
    getClientProfile(ctx, viewer.companyId, ref.kind, ref.id).catch(() => null),
    listClientLeads(ctx, viewer.companyId, ref.kind, ref.id, 20).catch(() => []),
    clientSitesAndProjects(ctx, viewer, ref, (account ?? contact)!.name),
    clientLeadForms(ctx, viewer.companyId, ref).catch(() => []),
    clientCareView(ctx, viewer.companyId, ref).catch(() => null),
    clientAgreementsAndGrowth(ctx, viewer.companyId, ref).catch(() => ({ agreements: null, growth: null })),
  ]);
  return {
    ...base,
    found: true as const,
    care,
    agreements: agreementsAndGrowth.agreements,
    growth: agreementsAndGrowth.growth,
    company: account,
    contact,
    profile: profileRecord ? { ...pickProfile(profileRecord), humanOwned: profileRecord.humanOwned, updatedAt: profileRecord.updatedAt } : null,
    clientLeads,
    leadForms,
    ...sitesAndProjects,
    contacts,
    companies,
    deals,
    activities,
    stages: stages.map((stage) => ({ id: stage.id, name: stage.name, kind: stage.kind, position: stage.position })),
    sequences: sequences.map((row) => ({ id: row.id, name: row.name, completionMode: row.completion_mode })),
    options: {
      companies: visibleAccounts.map((row) => ({ id: row.id, name: row.name })),
      contacts: visibleContacts.map((row) => ({ id: row.id, name: row.name })),
    },
  };
}

async function linkAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return linkRecords(ctx, await actionViewer(ctx, context), params);
}

async function createDealAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createDeal(ctx, await actionViewer(ctx, context), params);
}

async function moveDealAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return moveDeal(ctx, await actionViewer(ctx, context), params);
}

async function activityAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return logActivity(ctx, await actionViewer(ctx, context), params);
}

async function shareAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return shareRecord(ctx, await actionViewer(ctx, context), params);
}

async function createSequenceAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createSequence(ctx, await actionViewer(ctx, context), params);
}

async function enrollAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return enroll(ctx, await actionViewer(ctx, context), params);
}

async function humanOwnedAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  if (context.actor.type !== "user") throw new CrmError("Only a person can mark a field human-owned");
  const viewer = await actionViewer(ctx, context);
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
  const humanOwned = stringList(params, "humanOwned") ?? [];
  if (recordType === "company") {
    const account = await requireAccount(ctx, viewer, recordId);
    account.humanOwned = humanOwned;
    await saveAccount(ctx, account);
    return account;
  }
  if (recordType === "contact") {
    const contact = await requireContact(ctx, viewer, recordId);
    contact.humanOwned = humanOwned;
    await saveContact(ctx, contact);
    return contact;
  }
  const deal = await requireDeal(ctx, viewer, recordId);
  deal.humanOwned = humanOwned;
  await saveDeal(ctx, deal);
  return deal;
}

async function createProductAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createProductRecord(ctx, await actionViewer(ctx, context), params);
}

async function updateProductAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return updateProductRecord(ctx, await actionViewer(ctx, context), params);
}

async function scoreContactAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return scoreContactRecord(ctx, await actionViewer(ctx, context), params);
}

async function activitiesAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const viewer = await actionViewer(ctx, context);
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
  await requireRecord(ctx, viewer, recordType, recordId);
  return listActivities(ctx, recordType, recordId);
}

async function createProductRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const product = createProduct({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    description: optionalString(params, "description"),
    unitAmountMinor: params.unitAmountMinor == null ? 0 : assertAmountMinor(params.unitAmountMinor),
    currency: optionalString(params, "currency"),
  });
  await insertProduct(ctx, product);
  return product;
}

async function updateProductRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const product = await requireProduct(ctx, viewer, requiredString(params, "productId"));
  if (params.name !== undefined) product.name = assertProductName(String(params.name));
  if (params.description !== undefined) product.description = String(params.description).trim();
  if (params.unitAmountMinor !== undefined) product.unitAmountMinor = assertAmountMinor(params.unitAmountMinor);
  if (params.currency !== undefined) product.currency = assertCurrency(String(params.currency));
  if (params.isActive !== undefined) product.isActive = params.isActive === true;
  await saveProduct(ctx, product);
  return product;
}

async function scoreContactRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const engagement = await contactEngagement(ctx, contact.id);
  const score = scoreContact({
    lifecycle: contact.lifecycle,
    hasEmail: contact.emails.length > 0,
    hasPhone: contact.phones.length > 0,
    hasNextAction: contact.nextActionKind != null && contact.nextActionDueAt != null,
    activityCount: engagement.activityCount,
    lastActivityAt: engagement.lastActivityAt,
    tags: contact.tags,
    now: new Date().toISOString(),
  });
  // Jev reads name, role, company, lifecycle, tags and recent activity; the rule score stays as a fallback.
  const jevReady = (await jevConfigFor(ctx, viewer.companyId)) != null;
  const jev = jevReady ? await scoreLead(ctx, viewer.companyId, contact.id) : null;
  return {
    contactId: contact.id,
    ...score,
    band: scoreBand(score.total),
    jev,
    ...(jev ? {} : { jevNote: jevReady ? "Smart sorting did not answer; showing the rule score only." : "Smart sorting is not set up; showing the rule score only." }),
  };
}

async function requireProduct(ctx: PluginContext, viewer: Viewer, id: string): Promise<ProductDraft> {
  const product = await getProduct(ctx, id);
  if (!product) throw new CrmError("Product was not found");
  if (product.companyId !== viewer.companyId) throw new CrmError("Product is not visible");
  return product;
}

async function findDuplicates(ctx: PluginContext, viewer: Viewer) {
  return duplicateGroups(await findDuplicateContacts(ctx, viewer.companyId));
}

async function mergeContactsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const primaryId = contactIdOf(params, "primaryContactId");
  const duplicateId = contactIdOf(params, "duplicateContactId");
  assertMergeTargets(primaryId, duplicateId);
  const primary = await requireContact(ctx, viewer, primaryId);
  const duplicate = await requireContact(ctx, viewer, duplicateId);
  if (primary.companyId !== viewer.companyId || duplicate.companyId !== viewer.companyId) {
    throw new CrmError("Merges stay inside this workspace");
  }
  await mergeContacts(ctx, { companyId: viewer.companyId, primaryId, duplicateId });
  return { primaryId, duplicateId, merged: true };
}

async function createSavedViewRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const view = createSavedView({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    recordType: requiredString(params, "recordType"),
    filters: asRecord(params.filters),
    createdByUserId: viewer.userId,
  });
  await insertSavedView(ctx, {
    id: view.id,
    company_id: view.companyId,
    name: view.name,
    record_type: view.recordType,
    filters: view.filters,
    created_by_user_id: view.createdByUserId,
  });
  return view;
}

async function listSavedViewsRecord(ctx: PluginContext, viewer: Viewer) {
  const rows = await listSavedViews(ctx, viewer.companyId);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    recordType: row.record_type,
    filters: asRecord(row.filters),
  }));
}

async function deleteSavedViewRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = requiredString(params, "viewId");
  const deleted = await deleteSavedView(ctx, viewer.companyId, id);
  if (!deleted) throw new CrmError("Saved view was not found");
  return { deleted: true, viewId: id };
}

const EXPORT_COLUMNS = ["id", "ref", "name", "emails", "phones", "lifecycle", "email_status", "tags", "companies"];

async function exportContacts(ctx: PluginContext, viewer: Viewer) {
  const [contacts, links, grants] = await Promise.all([listContacts(ctx, viewer.companyId), listLinks(ctx, viewer.companyId), grantsFor(ctx, "contact", viewer.companyId)]);
  const visible = contacts.filter((contact) => canSeeRecord(viewer, contact, grants.get(contact.id) ?? []));
  const rows = visible.map((contact) => ({
    id: contact.id,
    ref: refOf("contact", contact.id),
    name: contact.name,
    emails: contact.emails.join(";"),
    phones: contact.phones.join(";"),
    lifecycle: contact.lifecycle,
    email_status: contact.emailStatus ?? "ok",
    tags: contact.tags.join(";"),
    companies: links.filter((link) => link.contactId === contact.id).map((link) => refOf("company", link.accountId)).join(";"),
  }));
  return { csv: toCsv(EXPORT_COLUMNS, rows), count: rows.length, columns: EXPORT_COLUMNS };
}

async function importContacts(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const csv = requiredString(params, "csv");
  const parsed = parseCsv(csv);
  if (parsed.length < 2) throw new CrmError("CSV needs a header row and at least one contact");
  const headers = parsed[0].map((header) => header.trim().toLowerCase());
  const nameIdx = headers.indexOf("name");
  const emailIdx = headers.indexOf("emails");
  const phoneIdx = headers.indexOf("phones");
  const lifecycleIdx = headers.indexOf("lifecycle");
  const tagsIdx = headers.indexOf("tags");
  if (nameIdx < 0) throw new CrmError("CSV needs a name column");
  let created = 0;
  let updated = 0;
  for (let i = 1; i < parsed.length; i++) {
    const row = parsed[i];
    const name = (row[nameIdx] ?? "").trim();
    if (!name) continue;
    const emails = normalizeEmails(splitList(row[emailIdx]));
    const phones = splitList(row[phoneIdx]);
    const tags = splitList(row[tagsIdx]);
    // Earlier rows are already saved, so a person listed twice in the file is matched too.
    const existing = await findExistingContact(ctx, viewer.companyId, emails, phones);
    if (existing) {
      await foldIntoExisting(ctx, existing, { name, emails, phones, tags }, `Import row ${i + 1}`);
      updated += 1;
      continue;
    }
    const contact = createContact({
      companyId: viewer.companyId,
      name,
      emails,
      phones,
      lifecycle: lifecycleIdx >= 0 ? row[lifecycleIdx] : undefined,
      tags,
      ownerUserId: viewer.userId,
      assigneeAgentId: viewer.agentId,
    });
    await insertContact(ctx, contact);
    created += 1;
  }
  return { created, updated };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(";").map((part) => part.trim()).filter(Boolean);
}

async function fieldHistory(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = recordIdOf(params, recordType);
  await requireRecord(ctx, viewer, recordType, recordId);
  const facts = await listFacts(ctx, recordType, recordId);
  return { recordType, recordId, facts };
}

async function bulkTagContacts(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contactIds = (stringList(params, "contactIds") ?? []).map((id) => idOf(id, "contact"));
  const tags = stringList(params, "tags") ?? [];
  const action = requiredString(params, "action");
  if (action !== "add" && action !== "remove") throw new CrmError("Action must be add or remove");
  if (contactIds.length === 0) throw new CrmError("At least one contact is required");
  if (tags.length === 0) throw new CrmError("At least one tag is required");
  let updated = 0;
  for (const contactId of contactIds) {
    const contact = await requireContact(ctx, viewer, contactId);
    const current = new Set(contact.tags.map((tag) => tag.toLowerCase()));
    if (action === "add") {
      for (const tag of tags) current.add(tag.toLowerCase());
    } else {
      for (const tag of tags) current.delete(tag.toLowerCase());
    }
    contact.tags = [...current];
    await saveContact(ctx, contact);
    updated += 1;
  }
  return { updated, action, tags };
}

async function contactGraph(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const links = (await listLinks(ctx, viewer.companyId)).filter((link) => link.contactId === contact.id);
  const accounts = [];
  for (const link of links) {
    const account = await getAccount(ctx, link.accountId);
    if (account) accounts.push({ id: account.id, name: account.name, role: link.roleLabel });
  }
  const deals = (await listDeals(ctx, viewer.companyId)).filter((deal) => deal.contactId === contact.id);
  const activities = await listActivities(ctx, "contact", contact.id, 20);
  return {
    contact: { ref: refOf("contact", contact.id), id: contact.id, name: contact.name, lifecycle: contact.lifecycle, tags: contact.tags },
    companies: accounts,
    deals: deals.map((deal) => ({ id: deal.id, title: deal.title, amountMinor: deal.amountMinor, currency: deal.currency })),
    activities,
  };
}

async function pipelineForecast(ctx: PluginContext, viewer: Viewer) {
  const pipeline = await ensurePipeline(ctx, viewer.companyId);
  const stages = await listStages(ctx, pipeline.pipelineId);
  const deals = await listDeals(ctx, viewer.companyId);
  const visibleDeals = deals.filter((deal) => canSeeRecord(viewer, deal, []));
  return forecastPipeline({
    stages: stages.map((stage) => ({ id: stage.id, name: stage.name, kind: stageKind(stage.kind), position: stage.position })),
    deals: visibleDeals.map((deal) => ({ stageId: deal.stageId, amountMinor: deal.amountMinor, currency: deal.currency })),
  });
}

async function addDealProduct(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const deal = await requireDeal(ctx, viewer, requiredString(params, "dealId"));
  if (params.quantity != null && (!Number.isInteger(params.quantity) || Number(params.quantity) < 1)) throw new CrmError("quantity must be a whole number of at least 1");
  const product = await requireProduct(ctx, viewer, requiredString(params, "productId"));
  const line = createDealProduct({
    companyId: viewer.companyId,
    dealId: deal.id,
    productId: product.id,
    quantity: params.quantity == null ? 1 : Number(params.quantity),
    unitAmountMinor: params.unitAmountMinor == null ? product.unitAmountMinor : assertAmountMinor(params.unitAmountMinor),
  });
  await insertDealProduct(ctx, {
    id: line.id,
    company_id: line.companyId,
    deal_id: line.dealId,
    product_id: line.productId,
    quantity: line.quantity,
    unit_amount_minor: line.unitAmountMinor,
  });
  return line;
}

async function listDealProductsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const deal = await requireDeal(ctx, viewer, requiredString(params, "dealId"));
  const rows = await listDealProducts(ctx, deal.id);
  return rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    quantity: Number(row.quantity),
    unitAmountMinor: Number(row.unit_amount_minor),
  }));
}

async function createCompany(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const name = requiredString(params, "name");
  const domain = normalizeDomain(optionalString(params, "domain"));
  const [existing] = await companiesByDomainOrName(ctx, viewer.companyId, domain, name);
  if (existing) {
    const filled: string[] = [];
    if (domain && !existing.domain && !existing.humanOwned.includes("domain")) {
      existing.domain = optionalString(params, "domain")!.trim();
      filled.push("domain");
    }
    for (const key of BILLING_KEYS) {
      const incoming = normalizeBillingField(key, optionalString(params, key));
      if (!incoming || existing[key] || existing.humanOwned.includes(key)) continue;
      existing[key] = incoming;
      filled.push(key);
    }
    const newTags = (stringList(params, "tags") ?? []).filter((t) => !existing.tags.some((have) => have.toLowerCase() === t.toLowerCase()));
    if (newTags.length && !(existing.humanOwned.includes("tags") && existing.tags.length)) {
      existing.tags = [...existing.tags, ...newTags];
      filled.push("tags");
    }
    for (const [key, value] of Object.entries(customOf(params) ?? {})) {
      const current = existing.custom[key];
      if (value === null || value === undefined || value === "" || (current !== null && current !== undefined && current !== "")) continue;
      existing.custom = { ...existing.custom, [key]: value };
      filled.push(key);
    }
    if (filled.length) await saveAccount(ctx, existing);
    const on = domain && normalizeDomain(existing.domain) === domain ? `website ${domain}` : `name ${existing.name}`;
    await insertActivity(ctx, {
      companyId: existing.companyId,
      recordType: "company",
      recordId: existing.id,
      kind: "note",
      body: `Creating a company matched this one on ${on}, so no second record was created.${filled.length ? ` Added: ${filled.join(", ")}.` : ""}`,
    }).catch(() => undefined);
    return { ...existing, matched: true, matchedOn: on, filled };
  }
  const account = createAccount({
    companyId: viewer.companyId,
    name,
    domain: optionalString(params, "domain"),
    billingEmail: optionalString(params, "billingEmail"),
    phone: optionalString(params, "phone"),
    address: optionalString(params, "address"),
    vatNumber: optionalString(params, "vatNumber"),
    registrationNumber: optionalString(params, "registrationNumber"),
    lifecycle: optionalString(params, "lifecycle"),
    currency: optionalString(params, "currency"),
    tags: stringList(params, "tags"),
    custom: customOf(params),
    ownerUserId: viewer.userId,
    assigneeAgentId: viewer.agentId,
  });
  await insertAccount(ctx, account);
  return account;
}

async function updateCompany(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const account = await requireAccount(ctx, viewer, companyIdOf(params));
  const lifecycleBefore = account.lifecycle;
  const result = applyFieldPatch({
    columns: {
      name: account.name,
      domain: account.domain,
      lifecycle: account.lifecycle,
      currency: account.currency,
      tags: account.tags,
      billingEmail: account.billingEmail,
      phone: account.phone,
      address: account.address,
      vatNumber: account.vatNumber,
      registrationNumber: account.registrationNumber,
    },
    custom: account.custom,
    humanOwned: account.humanOwned,
    columnKeys: columnKeysFor("company"),
    patch: patchFrom(params, ["name", "domain", "lifecycle", "currency", "tags", ...BILLING_KEYS]),
    source,
  });
  normalizeAccountColumns(result.columns);
  account.name = String(result.columns.name ?? account.name);
  account.domain = (result.columns.domain as string | null) ?? null;
  account.lifecycle = assertLifecycle(String(result.columns.lifecycle ?? account.lifecycle));
  account.currency = assertCurrency(String(result.columns.currency ?? account.currency));
  account.tags = asStringList(result.columns.tags);
  for (const key of BILLING_KEYS) account[key] = result.columns[key] as string | null;
  account.custom = result.custom;
  await saveAccount(ctx, account);
  await insertFacts(ctx, account.companyId, "company", account.id, result.facts);
  if (account.lifecycle === "churned" && lifecycleBefore !== "churned") await offboardCompany(ctx, account);
  return { ...account, refused: result.refused };
}

/** A company became churned: its people's running sequences stop, and it is logged. */
async function offboardCompany(ctx: PluginContext, account: AccountDraft): Promise<void> {
  const people = (await listLinks(ctx, account.companyId)).filter((link) => link.accountId === account.id);
  for (const link of people) await stopEnrollmentsForContact(ctx, account.companyId, link.contactId);
  await insertActivity(ctx, {
    companyId: account.companyId,
    recordType: "company",
    recordId: account.id,
    kind: "note",
    body: `Lifecycle set to churned: stopped the sequences of ${people.length} ${people.length === 1 ? "person" : "people"}.`,
  }).catch(() => undefined);
}

/** The oldest contact sharing an email, else a phone (last 9 digits), with what matched. */
async function findExistingContact(ctx: PluginContext, companyId: string, emails: string[], phones: string[]): Promise<{ contact: ContactDraft; on: string } | null> {
  for (const email of emails) {
    const [hit] = await contactsByEmail(ctx, companyId, email);
    if (hit) return { contact: hit, on: `email ${email}` };
  }
  for (const phone of phones) {
    const key = phoneMatchKey(phone);
    if (!key) continue;
    const [hit] = await contactsByPhone(ctx, companyId, key);
    if (hit) return { contact: hit, on: `phone ${phone}` };
  }
  return null;
}

/**
 * Adds the new details to the contact that already has this email or phone
 * (never a second record) and logs it. Returns the contact, marked `matched`.
 */
async function foldIntoExisting(
  ctx: PluginContext,
  match: { contact: ContactDraft; on: string },
  fill: ContactFill,
  via: string,
): Promise<ContactDraft & { matched: true; matchedOn: string; filled: string[] }> {
  const { contact } = match;
  const filled = fillContact(contact, fill);
  if (filled.length) await saveContact(ctx, contact);
  await insertActivity(ctx, {
    companyId: contact.companyId,
    recordType: "contact",
    recordId: contact.id,
    kind: "note",
    body: `${via} matched this contact on ${match.on}, so no second record was created.${filled.length ? ` Added: ${filled.join(", ")}.` : ""}`,
  }).catch(() => undefined);
  return { ...contact, matched: true, matchedOn: match.on, filled };
}

async function createContactRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const emails = normalizeEmails(stringList(params, "emails") ?? []);
  const phones = stringList(params, "phones") ?? [];
  const existing = await findExistingContact(ctx, viewer.companyId, emails, phones);
  if (existing) {
    return foldIntoExisting(ctx, existing, {
      name: requiredString(params, "name"),
      emails,
      phones,
      tags: stringList(params, "tags"),
      custom: customOf(params),
      nextActionKind: params.nextActionKind === undefined || params.nextActionKind === null ? null : assertNextAction(params.nextActionKind),
      nextActionDueAt: optionalString(params, "nextActionDueAt") ?? null,
    }, "Creating a contact");
  }
  const contact = createContact({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    emails,
    phones,
    lifecycle: optionalString(params, "lifecycle"),
    tags: stringList(params, "tags"),
    custom: customOf(params),
    nextActionKind: params.nextActionKind,
    nextActionDueAt: optionalString(params, "nextActionDueAt") ?? null,
    ownerUserId: viewer.userId,
    assigneeAgentId: viewer.agentId,
  });
  await insertContact(ctx, contact);
  scoreLeadLater(ctx, viewer.companyId, contact.id);
  return contact;
}

async function updateContact(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const lifecycleBefore = contact.lifecycle;
  const result = applyFieldPatch({
    columns: {
      name: contact.name,
      emails: contact.emails,
      phones: contact.phones,
      lifecycle: contact.lifecycle,
      tags: contact.tags,
      nextActionKind: contact.nextActionKind,
      nextActionDueAt: contact.nextActionDueAt,
    },
    custom: contact.custom,
    humanOwned: contact.humanOwned,
    columnKeys: columnKeysFor("contact"),
    patch: patchFrom(params, ["name", "emails", "phones", "lifecycle", "tags", "nextActionKind", "nextActionDueAt"]),
    source,
  });
  contact.name = String(result.columns.name ?? contact.name).trim();
  if (!contact.name) throw new CrmError("Contact name is required");
  contact.emails = asStringList(result.columns.emails);
  contact.phones = asStringList(result.columns.phones);
  contact.lifecycle = assertLifecycle(String(result.columns.lifecycle ?? contact.lifecycle));
  contact.tags = asStringList(result.columns.tags);
  contact.nextActionKind = assertNextAction(result.columns.nextActionKind);
  contact.nextActionDueAt = result.columns.nextActionDueAt == null ? null : String(result.columns.nextActionDueAt);
  contact.custom = result.custom;
  await saveContact(ctx, contact);
  await insertFacts(ctx, contact.companyId, "contact", contact.id, result.facts);
  if (contact.lifecycle === "churned" && lifecycleBefore !== "churned") {
    await stopEnrollmentsForContact(ctx, contact.companyId, contact.id);
    await insertActivity(ctx, { companyId: contact.companyId, recordType: "contact", recordId: contact.id, kind: "note", body: "Lifecycle set to churned: running sequences stopped." }).catch(() => undefined);
  }
  scoreLeadLater(ctx, viewer.companyId, contact.id);
  return { ...contact, refused: result.refused };
}

async function linkRecords(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const account = await requireAccount(ctx, viewer, companyIdOf(params));
  if (contact.companyId !== viewer.companyId || account.companyId !== viewer.companyId) {
    throw new CrmError("Links stay inside this workspace");
  }
  const link = linkContact({
    companyId: viewer.companyId,
    contactId: contact.id,
    accountId: account.id,
    roleLabel: optionalString(params, "roleLabel"),
  });
  await insertLink(ctx, link);
  return { ...link, contact: refOf("contact", contact.id), company: refOf("company", account.id) };
}

async function logActivity(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = recordIdOf(params, recordType);
  const kind = assertActivityKind(params.kind);
  await requireRecord(ctx, viewer, recordType, recordId);
  const id = await insertActivity(ctx, {
    companyId: viewer.companyId,
    recordType,
    recordId,
    kind,
    body: requiredString(params, "body"),
    issueId: optionalString(params, "issueId"),
  });
  return { id, recordType, recordId, kind };
}

async function createDeal(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const pipeline = await ensurePipeline(ctx, viewer.companyId);
  const accountId = optionalId(params, "companyRecordId", "company");
  const contactId = optionalId(params, "contactId", "contact");
  if (accountId) await requireAccount(ctx, viewer, accountId);
  if (contactId) await requireContact(ctx, viewer, contactId);
  const deal: DealDraft = {
    id: randomUUID(),
    companyId: viewer.companyId,
    pipelineId: pipeline.pipelineId,
    stageId: pipeline.openStageId,
    accountId: accountId ?? null,
    contactId: contactId ?? null,
    title: requiredString(params, "title"),
    amountMinor: params.amountMinor == null ? 0 : assertAmountMinor(params.amountMinor),
    currency: assertCurrency(optionalString(params, "currency") ?? "ZAR"),
    ownerUserId: viewer.userId,
    assigneeAgentId: viewer.agentId,
    tags: [],
    nextActionKind: assertNextAction(params.nextActionKind),
    nextActionDueAt: optionalString(params, "nextActionDueAt") ?? null,
    custom: {},
    humanOwned: [],
  };
  await insertDeal(ctx, deal);
  return { ...deal, client: deal.accountId ? refOf("company", deal.accountId) : deal.contactId ? refOf("contact", deal.contactId) : null };
}

async function moveDeal(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, how = "in the CRM") {
  const deal = await requireDeal(ctx, viewer, requiredString(params, "dealId"));
  const stage = await resolveStage(ctx, deal, requiredString(params, "stageId"));
  // The accepted quote this move closes (a "pick the deal" hand-off): the deal records it.
  const quoteId = optionalString(params, "quoteId");
  if (quoteId && stageKind(stage.kind) !== "won") throw new CrmError("quoteId goes with stageId won: an accepted quote closes the deal.");
  const moved = await moveDealTo(ctx, quoteId ? await withQuote(ctx, deal, quoteId.slice(0, 200)) : deal, stage, how);
  return {
    ...moved.deal,
    stageName: stage.name,
    stageKind: moved.stageKind,
    ...(moved.won ? { won: moved.won, next: moved.won.firstWin ? "First win: the Cockpit opens onboarding. Fill the client profile (update-client-profile)." : "Won: Billing opens its drafting task." } : {}),
  };
}

/** `""` or null clears a link; a value is the id (or `company:<id>` / `contact:<id>`). */
function linkParam(params: Record<string, unknown>, key: string, kind: "company" | "contact"): string | null | undefined {
  if (!(key in params)) return undefined;
  const value = params[key];
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") throw new CrmError(`${key} must be a string`);
  return idOf(value.trim(), kind);
}

/**
 * Title, value and currency, who the deal is for (its company and contact),
 * and its stage. A stage change is a move (won and lost do what move-deal
 * does). Fields a person locked keep their value when an agent writes.
 */
async function updateDealRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const deal = await requireDeal(ctx, viewer, requiredString(params, "dealId"));
  const result = applyFieldPatch({
    columns: { title: deal.title, amountMinor: deal.amountMinor, currency: deal.currency },
    custom: deal.custom,
    humanOwned: deal.humanOwned,
    columnKeys: columnKeysFor("deal"),
    patch: patchFrom(params, ["title", "amountMinor", "currency"]),
    source,
  });
  const next: DealDraft = { ...deal, custom: result.custom };
  const title = String(result.columns.title ?? "").trim();
  if (!title) throw new CrmError("Deal title is required");
  next.title = title;
  next.amountMinor = assertAmountMinor(result.columns.amountMinor ?? 0);
  next.currency = assertCurrency(String(result.columns.currency ?? deal.currency));

  const facts = [...result.facts];
  const accountId = linkParam(params, "companyRecordId", "company");
  if (accountId !== undefined && accountId !== deal.accountId) {
    if (accountId) {
      const account = await requireAccount(ctx, viewer, accountId);
      if (account.companyId !== deal.companyId) throw new CrmError("Links stay inside this workspace");
    }
    next.accountId = accountId;
    facts.push({ fieldKey: "companyRecordId", value: accountId, source, refused: false });
  }
  const contactId = linkParam(params, "contactId", "contact");
  if (contactId !== undefined && contactId !== deal.contactId) {
    if (contactId) {
      const contact = await requireContact(ctx, viewer, contactId);
      if (contact.companyId !== deal.companyId) throw new CrmError("Links stay inside this workspace");
    }
    next.contactId = contactId;
    facts.push({ fieldKey: "contactId", value: contactId, source, refused: false });
  }

  const how = source === "human" ? "in the CRM" : "by an agent in the CRM";
  const stageValue = optionalString(params, "stageId");
  const stage = stageValue ? await resolveStage(ctx, next, stageValue) : null;
  let won: Awaited<ReturnType<typeof onDealWon>> | null = null;
  let saved = next;
  if (stage && stage.id !== deal.stageId) {
    // The move saves every field above too, then runs the won / lost effects.
    const moved = await moveDealTo(ctx, next, stage, how);
    saved = moved.deal;
    won = moved.won;
  } else {
    await saveDeal(ctx, next);
    // A deal won without a client could not make anyone a customer or tell Billing: linking its client now does.
    const hadClient = Boolean(deal.accountId || deal.contactId);
    const isWon = stageKind((await listStages(ctx, deal.pipelineId).catch(() => [])).find((row) => row.id === next.stageId)?.kind ?? "open") === "won";
    if (isWon && !hadClient && (next.accountId || next.contactId)) won = await onDealWon(ctx, next, `${how}, when its client was linked`);
  }
  await insertFacts(ctx, deal.companyId, "deal", deal.id, facts);
  const stages = await listStages(ctx, saved.pipelineId).catch(() => []);
  const current = stages.find((row) => row.id === saved.stageId);
  return {
    ...saved,
    stageName: current?.name ?? null,
    stageKind: stageKind(current?.kind ?? "open"),
    client: saved.accountId ? refOf("company", saved.accountId) : saved.contactId ? refOf("contact", saved.contactId) : null,
    refused: result.refused,
    ...(won ? { won, next: won.issueId ? "Won, but it still has no client: link one (companyRecordId or contactId)." : won.firstWin ? "First win: the Cockpit opens onboarding. Fill the client profile (update-client-profile)." : "Won: Billing opens its drafting task." } : {}),
  };
}

/** One sequence for its drawer: steps in order and who is enrolled (people this viewer may see). */
async function sequenceDetail(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const sequence = await getSequence(ctx, requiredString(params, "sequenceId"));
  if (!sequence || sequence.company_id !== viewer.companyId) throw new CrmError("Sequence was not found");
  const [steps, enrollments, records] = await Promise.all([
    listSteps(ctx, sequence.id),
    enrollmentsForSequence(ctx, viewer.companyId, sequence.id),
    visibleRecords(ctx, viewer),
  ]);
  const names = new Map(records.visibleContacts.map((row) => [row.id, row.name]));
  const mine = enrollments.filter((row) => row.sequenceId === sequence.id);
  const enrolled = mine
    .filter((row) => names.has(row.contactId))
    .map((row) => ({
      contactId: row.contactId,
      name: names.get(row.contactId)!,
      status: row.status,
      stepPosition: row.stepPosition,
      nextDueAt: row.nextDueAt,
      // A due step waits on its issue (done by a person or agent) or on the Mailbox sending it.
      issueId: row.openIssueId,
      sending: Boolean(row.sendingKey),
    }));
  return {
    id: sequence.id,
    name: sequence.name,
    delivery: sequenceDelivery(sequence),
    emailApproved: sequenceEmailApproved(sequence),
    completionMode: completionModeOf(sequence.completion_mode),
    steps: steps.map((step) => ({ position: step.position, delayMinutes: step.delayMinutes, title: step.title, body: step.body })),
    enrolled,
    hidden: mine.length - enrolled.length,
  };
}

/** A stage by id, by name (case-insensitive) or by the words won / lost. */
async function resolveStage(ctx: PluginContext, deal: DealDraft, value: string) {
  const byId = await getStage(ctx, value);
  if (byId) {
    if (byId.company_id !== deal.companyId) throw new CrmError("Stage was not found");
    return byId;
  }
  const stages = await listStages(ctx, deal.pipelineId);
  const lower = value.trim().toLowerCase();
  const byName = stages.find((stage) => stage.name.toLowerCase() === lower);
  if (byName) return byName;
  const byKind = lower === "won" || lower === "lost" ? stages.find((stage) => stageKind(stage.kind) === lower) : null;
  if (byKind) return byKind;
  throw new CrmError(`No stage ${value}. Stages: ${stages.map((stage) => stage.name).join(", ")} (list-stages has their ids).`);
}

async function shareRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = recordIdOf(params, recordType);
  const principalType = assertPrincipalType(requiredString(params, "principalType"));
  assertSharePrincipal(principalType);
  const record = await requireRecord(ctx, viewer, recordType, recordId);
  const principalId = requiredString(params, "principalId");
  await insertGrant(ctx, {
    companyId: record.companyId,
    recordType,
    recordId,
    principalType,
    principalId,
  });
  return { recordId, principalType, principalId };
}

async function defineRecordField(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const fieldKey = requiredString(params, "fieldKey");
  if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) throw new CrmError("Field key must be a lowercase identifier");
  await defineField(ctx, {
    companyId: viewer.companyId,
    recordType: assertRecordType(requiredString(params, "recordType")),
    fieldKey,
    label: requiredString(params, "label"),
    fieldType: assertFieldType(params.fieldType),
  });
  return { fieldKey, fieldType: assertFieldType(params.fieldType), next: "Values go in custom on create or update, e.g. custom: { \"" + fieldKey + "\": ... }." };
}

async function createSequence(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = randomUUID();
  const completionMode = completionModeOf(optionalString(params, "completionMode"));
  const delivery = assertDelivery(params.delivery);
  await insertSequence(ctx, { id, companyId: viewer.companyId, name: requiredString(params, "name"), completionMode });
  for (const step of stepsFrom(params)) {
    await insertStep(ctx, { companyId: viewer.companyId, sequenceId: id, step });
  }
  if (delivery === "email") {
    const sequence = await getSequence(ctx, id);
    if (sequence) {
      const set = await setDelivery(ctx, viewer.companyId, sequence, "email");
      return { id, name: requiredString(params, "name"), completionMode, delivery, emailApproved: set.emailApproved, approvalIssueId: set.approvalIssueId };
    }
  }
  return { id, name: requiredString(params, "name"), completionMode, delivery };
}

/** issue: due steps open issues (default). email: due steps are sent from the Mailbox once a board user approved. */
async function setSequenceDelivery(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const sequence = await getSequence(ctx, requiredString(params, "sequenceId"));
  if (!sequence || sequence.company_id !== viewer.companyId) throw new CrmError("Sequence was not found");
  if (params.delivery !== "issue" && params.delivery !== "email") throw new CrmError("Delivery must be issue or email");
  const result = await setDelivery(ctx, viewer.companyId, sequence, assertDelivery(params.delivery));
  return {
    ...result,
    message: result.delivery === "issue"
      ? "Due steps open issues."
      : result.emailApproved
        ? "Due steps are emailed from the Mailbox."
        : "Waiting for approval: a board user marks the approval issue done before any step is emailed.",
  };
}

async function enroll(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, contactIdOf(params));
  const sequence = await getSequence(ctx, requiredString(params, "sequenceId"));
  if (!sequence || sequence.company_id !== viewer.companyId) throw new CrmError("Sequence was not found");
  if (sequenceDelivery(sequence) === "email") assertCanEmail(contact.emailStatus);
  const steps = await listSteps(ctx, sequence.id);
  const existing = await enrollmentsForContact(ctx, sequence.id, contact.id);
  const enrollment = startEnrollment({
    companyId: viewer.companyId,
    sequenceId: sequence.id,
    contactId: contact.id,
    existing,
    steps,
    now: new Date(),
  });
  await insertEnrollment(ctx, enrollment);
  return enrollment;
}

async function openDueSteps(ctx: PluginContext) {
  const due = await dueEnrollments(ctx);
  const sequences = new Map<string, Promise<Awaited<ReturnType<typeof getSequence>>>>();
  const enabled = new Map<string, Promise<boolean>>();
  const prefixes = new Map<string, Promise<string | null>>();
  const approvalsChecked = new Set<string>();
  for (const enrollment of due) {
    try {
      if (!enabled.has(enrollment.companyId)) enabled.set(enrollment.companyId, isModuleEnabled(ctx, enrollment.companyId, PLUGIN_ID));
      if (!(await enabled.get(enrollment.companyId))) continue;
      const steps = await listSteps(ctx, enrollment.sequenceId);
      const step = steps.find((item) => item.position === enrollment.stepPosition);
      const contact = await getContact(ctx, enrollment.contactId);
      if (!step || !contact) continue;
      if (!sequences.has(enrollment.sequenceId)) sequences.set(enrollment.sequenceId, getSequence(ctx, enrollment.sequenceId));
      const sequence = await sequences.get(enrollment.sequenceId)!;
      if (!prefixes.has(enrollment.companyId)) prefixes.set(enrollment.companyId, companyPrefix(ctx, enrollment.companyId));
      const prefix = await prefixes.get(enrollment.companyId)!;
      const company = await contactCompanyName(ctx, contact.id);
      const copy = sequenceIssueCopy(contact.name, step, {
        contactId: contact.id,
        sequenceName: sequence?.name ?? "Sequence",
        stepCount: steps.length,
        completionMode: completionModeOf(sequence?.completion_mode),
        body: personalize(step.body, { name: contact.name, email: contact.emails[0] ?? null, company }),
        link: crmLink(prefix, "contact", contact.id),
      });
      // Explicit companyId: jobs have no invocation scope, and the host only
      // allows a job's call for a company that has saved CRM settings.
      const openIssue = async (note?: string) => {
        const issue = await createWorkIssue(ctx, {
          companyId: enrollment.companyId,
          title: copy.title,
          description: note ? `${note}\n\n${copy.description}` : copy.description,
          originKind: "plugin:partnersinbiz.crm",
          originId: originFor.step(enrollment.id, enrollment.stepPosition),
          ...(await contactAssignee(ctx, enrollment.companyId, contact)),
          wakeReason: "CRM sequence step is due",
        });
        enrollment.openIssueId = issue.id;
        await saveEnrollment(ctx, enrollment);
      };
      if (sequence && sequenceDelivery(sequence) === "email") {
        if (!sequenceEmailApproved(sequence)) {
          // Waits for a person's approval, visibly: the Cockpit lists the approval with its due steps.
          if (!approvalsChecked.has(sequence.id)) {
            approvalsChecked.add(sequence.id);
            await ensureApprovalOpen(ctx, enrollment.companyId, sequence);
          }
          continue;
        }
        await sendSequenceStep(ctx, { enrollment, step, contact, issueFallback: (note) => openIssue(note) });
        continue;
      }
      await openIssue();
    } catch (error) {
      ctx.logger.error("CRM due step failed", {
        enrollmentId: enrollment.id,
        companyId: enrollment.companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function contactCompanyName(ctx: PluginContext, contactId: string): Promise<string | null> {
  const links = await contactCompanyLinks(ctx, contactId).catch(() => []);
  return links[0]?.name ?? null;
}

async function afterMutation(ctx: PluginContext, companyId: string, name: string, params: Record<string, unknown>) {
  try {
    if ((name === "link-contact" || name === "crm.link-contact") && typeof params.contactId === "string") {
      await touchContact(ctx, params.contactId);
    }
    if (name === "merge-contacts" && typeof params.duplicateContactId === "string") {
      await emitContactDeleted(ctx, companyId, params.duplicateContactId);
    }
    await emitChanges(ctx, companyId, 120);
  } catch (error) {
    ctx.logger.info("CRM change broadcast deferred", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function emitForAllCompanies(ctx: PluginContext, sinceSeconds: number | null) {
  for (const companyId of await crmCompanyIds(ctx)) {
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      await emitChanges(ctx, companyId, sinceSeconds);
      await emitSites(ctx, companyId, sinceSeconds);
      if (sinceSeconds == null) {
        await recordFullShare(ctx, companyId);
        // Which clients are sensitive, said again every night for whoever missed it.
        await reemitSensitivity(ctx, companyId).catch(() => 0);
      }
    } catch (error) {
      ctx.logger.info("CRM change broadcast skipped", {
        companyId,
        hint: "Save the CRM plugin settings for this company so scheduled jobs may act on it.",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function syncKnownCompanies(ctx: PluginContext) {
  try {
    for (const companyId of await crmCompanyIds(ctx)) await skillSync?.ensure(companyId);
  } catch (error) {
    ctx.logger.info("CRM skill sync deferred", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** A partner grant was revoked: drop the company share written when it was accepted. */
async function onPartnerGrantRevoked(ctx: PluginContext, companyId: string, payload: unknown) {
  const body = asRecord(payload);
  const recordType = String(body.recordType ?? "");
  const recordId = String(body.recordId ?? "");
  const granteeCompanyId = String(body.granteeCompanyId ?? "");
  if (!companyId || !recordId || !granteeCompanyId || recordType === "invoice") return;
  try {
    await ctx.db.execute(
      `DELETE FROM ${table(ctx, "record_grants")}
        WHERE company_id = $1 AND record_type = $2 AND record_id = $3 AND principal_type = 'company' AND principal_id = $4`,
      [companyId, recordType, recordId, granteeCompanyId],
    );
  } catch (error) {
    ctx.logger.error("CRM partner share removal failed", { recordId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function resyncAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const counts = await emitChanges(ctx, viewer.companyId, null);
  const sites = await emitSites(ctx, viewer.companyId, null);
  await recordFullShare(ctx, viewer.companyId);
  return { ok: true, ...counts, sites };
}

async function syncSkillsAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const results = skillSync ? await skillSync.force(viewer.companyId) : [];
  return { ok: results.every((result) => result.action !== "failed"), results };
}

async function settingsStatusAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const config = await readConfig(ctx, viewer.companyId);
  return { saved: Object.keys(config).length > 0 };
}

async function onIssueUpdated(ctx: PluginContext, event: PluginEvent) {
  const issueId = event.entityId;
  if (!issueId) return;
  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;
  // An approval issue for email sending: approved when a board user marks it done.
  if (await onApprovalIssue(ctx, event, issue.status)) return;
  // An approval for an email to a client, or an erasure: a person decides.
  if (await onCareApprovalIssue(ctx, event, issue.status)) return;
  // A Mailbox Reply-needed issue: the support case on its thread is answered when it is done.
  await onReplyIssueUpdated(ctx, event.companyId, { id: issue.id, status: issue.status, originId: issue.originId ?? null }).catch(() => false);
  // A service step: done (its proof was checked above) means the service is started.
  if (await onServiceStepIssue(ctx, event.companyId, { id: issue.id, status: issue.status, originId: issue.originId ?? null })) return;
  if (issue.status !== "done") return;
  const enrollment = await enrollmentByIssue(ctx, issue.id);
  if (!enrollment) return;
  const sequence = await getSequence(ctx, enrollment.sequenceId);
  if (!sequence) return;
  // Marking a step's issue done moves the contact on, whatever the delivery: a
  // manual step is done, a sent step's message went out (its issue says to mark
  // it done only then), and an email step that could not be sent was handled by hand.
  // An agent's close counts only when the step's done-check passes (else it is reopened).
  if (event.actorType === "agent" && !(await closeStands(ctx, doneCheckIssue(issue, event.companyId)))) return;
  const steps = await listSteps(ctx, enrollment.sequenceId);
  await saveEnrollment(ctx, advanceEnrollment(enrollment, steps, new Date()));
}

async function acceptPartnerGrant(ctx: PluginContext, input: PluginApiRequestInput) {
  if (input.routeKey !== "record-grant") return { status: 404, body: { error: "Not found" } };
  try {
    const body = asRecord(input.body);
    const recordType = assertRecordType(String(body.recordType ?? ""));
    const recordId = String(body.recordId ?? "").trim();
    const granteeCompanyId = String(body.granteeCompanyId ?? "").trim();
    if (!recordId || !granteeCompanyId) {
      return { status: 400, body: { error: "recordId and granteeCompanyId are required" } };
    }
    const viewer = await viewerFor(ctx, {
      companyId: input.companyId,
      userId: input.actor.userId ?? input.actor.actorId,
      agentId: null,
    });
    if (viewer.role !== "owner" && viewer.role !== "admin") {
      return { status: 403, body: { error: "Only an owner or admin can share a record with a partner company" } };
    }
    const record = await loadAccess(ctx, recordType, recordId);
    if (!record || record.companyId !== input.companyId) return { status: 404, body: { error: "Record was not found" } };
    await insertGrant(ctx, {
      companyId: record.companyId,
      recordType,
      recordId,
      principalType: "company",
      principalId: granteeCompanyId,
    });
    return { status: 200, body: { ok: true, recordId, granteeCompanyId } };
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : "Grant failed" } };
  }
}

async function viewerFor(
  ctx: PluginContext,
  input: { companyId: string; userId: string | null; agentId: string | null; runId?: string | null },
): Promise<Viewer> {
  let userId = input.userId;
  if (!userId && input.runId && input.agentId) {
    const rows = await ctx.db.query<{ responsible_user_id: string | null }>(
      `SELECT responsible_user_id
         FROM public.heartbeat_runs
        WHERE id = $1 AND company_id = $2 AND agent_id = $3
        LIMIT 1`,
      [input.runId, input.companyId, input.agentId],
    );
    userId = rows[0]?.responsible_user_id ?? null;
  }
  let role: string | null = null;
  if (userId === LOCAL_BOARD_USER_ID) role = "owner";
  else if (userId) {
    const members = await ctx.access.members.list({ companyId: input.companyId });
    const member = members.find((item) => item.principalType === "user" && item.principalId === userId && item.status === "active");
    role = member?.membershipRole ?? null;
  }
  return { companyId: input.companyId, userId, agentId: input.agentId, role };
}

async function actionViewer(ctx: PluginContext, context: PluginPerformActionContext): Promise<Viewer> {
  if (!context.companyId) throw new CrmError("Company is required");
  return viewerFor(ctx, {
    companyId: context.companyId,
    userId: context.actor.userId,
    agentId: context.actor.agentId,
    runId: context.actor.runId,
  });
}

async function requireAccount(ctx: PluginContext, viewer: Viewer, id: string): Promise<AccountDraft> {
  const account = await getAccount(ctx, id);
  if (!account) throw new CrmError("Company was not found");
  const grants = await grantsFor(ctx, "company", viewer.companyId);
  return requireVisible(viewer, account, grants.get(id) ?? []);
}

async function requireContact(ctx: PluginContext, viewer: Viewer, id: string): Promise<ContactDraft> {
  const contact = await getContact(ctx, id);
  if (!contact) throw new CrmError("Contact was not found");
  const grants = await grantsFor(ctx, "contact", viewer.companyId);
  return requireVisible(viewer, contact, grants.get(id) ?? []);
}

async function requireDeal(ctx: PluginContext, viewer: Viewer, id: string): Promise<DealDraft> {
  const deal = await getDeal(ctx, id);
  if (!deal) throw new CrmError("Deal was not found");
  const grants = await grantsFor(ctx, "deal", viewer.companyId);
  return requireVisible(viewer, deal, grants.get(id) ?? []);
}

async function requireRecord(ctx: PluginContext, viewer: Viewer, recordType: RecordType, id: string) {
  if (recordType === "company") return requireAccount(ctx, viewer, id);
  if (recordType === "contact") return requireContact(ctx, viewer, id);
  return requireDeal(ctx, viewer, id);
}

async function loadAccess(ctx: PluginContext, recordType: RecordType, id: string) {
  if (recordType === "company") return getAccount(ctx, id);
  if (recordType === "contact") return getContact(ctx, id);
  return getDeal(ctx, id);
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrmError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new CrmError(`${key} is required`);
  return value.trim();
}

/** Accepts a bare id or the ref form (`contact:<id>`, `company:<id>`). */
function idOf(value: string, kind: "company" | "contact"): string {
  const prefix = `${kind}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function contactIdOf(params: Record<string, unknown>, key = "contactId"): string {
  return idOf(requiredString(params, key), "contact");
}

function companyIdOf(params: Record<string, unknown>, key = "companyRecordId"): string {
  return idOf(requiredString(params, key), "company");
}

function optionalId(params: Record<string, unknown>, key: string, kind: "company" | "contact"): string | undefined {
  const value = optionalString(params, key);
  return value ? idOf(value, kind) : undefined;
}

function recordIdOf(params: Record<string, unknown>, recordType: RecordType): string {
  const value = requiredString(params, "recordId");
  return recordType === "deal" ? value : idOf(value, recordType);
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new CrmError(`${key} must be a string`);
  return value.trim();
}

function stringList(params: Record<string, unknown>, key: string): string[] | undefined {
  if (params[key] == null) return undefined;
  const value = asStringList(params[key]);
  if (Array.isArray(params[key]) && value.length !== (params[key] as unknown[]).length) {
    throw new CrmError(`${key} must be a list of strings`);
  }
  return value;
}

function customOf(params: Record<string, unknown>): Record<string, unknown> | undefined {
  if (params.custom == null) return undefined;
  const value = asRecord(params.custom);
  if (Object.keys(value).length === 0 && (typeof params.custom !== "object" || Array.isArray(params.custom))) {
    throw new CrmError("custom must be an object");
  }
  return value;
}

function patchFrom(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...customOf(params) };
  for (const key of keys) {
    if (params[key] !== undefined) patch[key] = params[key];
  }
  return patch;
}

function normalizeAccountColumns(columns: Record<string, unknown>): void {
  if (typeof columns.name === "string") {
    const name = columns.name.trim();
    if (!name) throw new CrmError("Company name is required");
    columns.name = name;
  }
  if (typeof columns.domain === "string") columns.domain = columns.domain.trim() || null;
  if (typeof columns.lifecycle === "string") columns.lifecycle = assertLifecycle(columns.lifecycle);
  if (typeof columns.currency === "string") columns.currency = assertCurrency(columns.currency);
  for (const key of BILLING_KEYS) columns[key] = normalizeBillingField(key, columns[key]);
}

function completionModeOf(value: string | undefined): CompletionMode {
  return value === "sent" ? "sent" : "manual";
}

function stepsFrom(params: Record<string, unknown>): SequenceStepDraft[] {
  if (!Array.isArray(params.steps) || params.steps.length === 0) {
    return [{ position: 1, delayMinutes: 0, title: "Reach out", body: "" }];
  }
  return params.steps.map((item, index) => {
    if (!item || typeof item !== "object") throw new CrmError("Each step must be an object");
    const step = item as Record<string, unknown>;
    const title = typeof step.title === "string" ? step.title.trim() : "";
    if (!title) throw new CrmError("Step title is required");
    const position = typeof step.position === "number" ? step.position : index + 1;
    const delayMinutes = typeof step.delayMinutes === "number" ? step.delayMinutes : 0;
    return { position, delayMinutes, title, body: typeof step.body === "string" ? step.body : "" };
  });
}

/** What the agent reads: the result as JSON (ids, refs, links), capped. `data` carries the same. */
function toolContent(data: unknown): string {
  const json = JSON.stringify(data ?? { ok: true });
  return json.length <= 12_000 ? json : `${json.slice(0, 12_000)}… (truncated; the full result is in data)`;
}
