import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { asRecord, asStringList, table } from "./db.js";
import {
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
  saveDeal,
  saveEnrollment,
  stageKind,
  stopEnrollmentsForContact,
} from "./db.js";
import {
  advanceEnrollment,
  applyFieldPatch,
  assertAmountMinor,
  assertCurrency,
  assertMergeTargets,
  assertProductName,
  forecastPipeline,
  assertViewName,
  createSavedView,
  isDuplicatePair,
  normalizeEmail,
  parseCsv,
  toCsv,
  assertLifecycle,
  assertNextAction,
  assertPrincipalType,
  assertRecordType,
  assertSharePrincipal,
  canCompleteStep,
  canSeeRecord,
  columnKeysFor,
  createAccount,
  createContact,
  createDealProduct,
  createProduct,
  CrmError,
  scoreBand,
  scoreContact,
  linkContact,
  LOCAL_BOARD_USER_ID,
  requireVisible,
  sequenceIssueCopy,
  stageStopsEnrollments,
  startEnrollment,
  type AccountDraft,
  type CompletionMode,
  type ContactDraft,
  type DealDraft,
  type ProductDraft,
  type RecordType,
  type SequenceStepDraft,
  type Viewer,
} from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { CRM_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { CRM_MUTATIONS, crmCompanyIds, emitChanges, emitContactDeleted, touchContact } from "./sync.js";
import { createSkillSyncer, createWorkIssue, readConfig } from "@partnersinbiz/pib-plugin-kit";

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    const registerAction = (
      key: string,
      handler: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>,
    ) => {
      ctx.actions.register(key, async (params, context) => {
        if (context.companyId) void skillSync?.ensure(context.companyId);
        const result = await handler(params, context);
        if (context.companyId && CRM_MUTATIONS.has(key)) await afterMutation(ctx, context.companyId, key, params);
        return result;
      });
    };
    for (const tool of CRM_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    registerAction("crm.load", (_params, context) => load(ctx, context));
    registerAction("crm.create-company", (params, context) => createCompanyAction(ctx, context, params));
    registerAction("crm.create-contact", (params, context) => createContactAction(ctx, context, params));
    registerAction("crm.link-contact", (params, context) => linkAction(ctx, context, params));
    registerAction("crm.create-deal", (params, context) => createDealAction(ctx, context, params));
    registerAction("crm.move-deal", (params, context) => moveDealAction(ctx, context, params));
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
    ctx.jobs.register("open-due-steps", () => openDueSteps(ctx));
    ctx.jobs.register("emit-recent", () => emitForAllCompanies(ctx, 1800));
    ctx.jobs.register("emit-all", () => emitForAllCompanies(ctx, null));
    ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event.entityId, event.companyId));
    ctx.events.on("plugin.partnersinbiz.partners.grant.revoked", (event) => onPartnerGrantRevoked(ctx, event.companyId, event.payload));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
    await syncKnownCompanies(ctx);
    ctx.logger.info("CRM plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "CRM plugin ready" };
  },

  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "CRM plugin is not ready" } };
    return acceptPartnerGrant(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const viewer = await viewerFor(ctx, {
      companyId: run.companyId,
      userId: null,
      agentId: run.agentId,
      runId: run.runId,
    });
    const body = objectParams(params);
    void skillSync?.ensure(run.companyId);
    const data = await dispatch(ctx, viewer, name, body, "agent");
    if (CRM_MUTATIONS.has(name)) await afterMutation(ctx, run.companyId, name, body);
    if (data && typeof data === "object" && "refused" in data && Array.isArray(data.refused) && data.refused.length > 0) {
      return { error: `Refused to overwrite human-owned fields: ${data.refused.join(", ")}`, data };
    }
    return { content: toolContent(name, data), data };
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
    case "share-record":
      return shareRecord(ctx, viewer, body);
    case "define-field":
      return defineRecordField(ctx, viewer, body);
    case "create-sequence":
      return createSequence(ctx, viewer, body);
    case "enroll-contact":
      return enroll(ctx, viewer, body);
    case "complete-step":
      return completeStep(ctx, viewer, body);
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
    default:
      throw new CrmError(`Unknown CRM tool ${name}`);
  }
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const viewer = await actionViewer(ctx, context);
  const pipeline = await ensurePipeline(ctx, viewer.companyId);
  const [accounts, contacts, deals, links, sequences, stages, products] = await Promise.all([
    listAccounts(ctx, viewer.companyId),
    listContacts(ctx, viewer.companyId),
    listDeals(ctx, viewer.companyId),
    listLinks(ctx, viewer.companyId),
    listSequences(ctx, viewer.companyId),
    listStages(ctx, pipeline.pipelineId),
    listProducts(ctx, viewer.companyId),
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
  return {
    settingsSaved,
    accounts: visibleAccounts,
    contacts: visibleContacts,
    deals: visibleDeals,
    links: visibleLinks,
    sequences: sequences.map((row) => ({
      id: row.id,
      name: row.name,
      completionMode: row.completion_mode,
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
  const contact = await requireContact(ctx, viewer, requiredString(params, "contactId"));
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
  return { contactId: contact.id, ...score, band: scoreBand(score.total) };
}

async function requireProduct(ctx: PluginContext, viewer: Viewer, id: string): Promise<ProductDraft> {
  const product = await getProduct(ctx, id);
  if (!product) throw new CrmError("Product was not found");
  if (product.companyId !== viewer.companyId) throw new CrmError("Product is not visible");
  return product;
}

async function findDuplicates(ctx: PluginContext, viewer: Viewer) {
  const contacts = await findDuplicateContacts(ctx, viewer.companyId);
  const groups: Array<{ email: string; contacts: Array<{ id: string; name: string }> }> = [];
  const byEmail = new Map<string, Array<{ id: string; name: string }>>();
  for (const contact of contacts) {
    for (const email of contact.emails.map(normalizeEmail).filter(Boolean)) {
      const list = byEmail.get(email) ?? [];
      list.push({ id: contact.id, name: contact.name });
      byEmail.set(email, list);
    }
  }
  for (const [email, list] of byEmail) {
    if (list.length > 1) groups.push({ email, contacts: list });
  }
  return groups;
}

async function mergeContactsRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const primaryId = requiredString(params, "primaryContactId");
  const duplicateId = requiredString(params, "duplicateContactId");
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

async function exportContacts(ctx: PluginContext, viewer: Viewer) {
  const contacts = await listContacts(ctx, viewer.companyId);
  const visible = contacts.filter((contact) => canSeeRecord(viewer, contact, []));
  const rows = visible.map((contact) => ({
    name: contact.name,
    emails: contact.emails.join(";"),
    phones: contact.phones.join(";"),
    lifecycle: contact.lifecycle,
    tags: contact.tags.join(";"),
  }));
  return { csv: toCsv(["name", "emails", "phones", "lifecycle", "tags"], rows), count: rows.length };
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
  for (let i = 1; i < parsed.length; i++) {
    const row = parsed[i];
    const name = (row[nameIdx] ?? "").trim();
    if (!name) continue;
    const contact = createContact({
      companyId: viewer.companyId,
      name,
      emails: splitList(row[emailIdx]),
      phones: splitList(row[phoneIdx]),
      lifecycle: lifecycleIdx >= 0 ? row[lifecycleIdx] : undefined,
      tags: splitList(row[tagsIdx]),
      ownerUserId: viewer.userId,
      assigneeAgentId: viewer.agentId,
    });
    await insertContact(ctx, contact);
    created += 1;
  }
  return { created };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(";").map((part) => part.trim()).filter(Boolean);
}

async function fieldHistory(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
  await requireRecord(ctx, viewer, recordType, recordId);
  const facts = await listFacts(ctx, recordType, recordId);
  return { recordType, recordId, facts };
}

async function bulkTagContacts(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contactIds = stringList(params, "contactIds") ?? [];
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
  const contact = await requireContact(ctx, viewer, requiredString(params, "contactId"));
  const links = (await listLinks(ctx, viewer.companyId)).filter((link) => link.contactId === contact.id);
  const accounts = [];
  for (const link of links) {
    const account = await getAccount(ctx, link.accountId);
    if (account) accounts.push({ id: account.id, name: account.name, role: link.roleLabel });
  }
  const deals = (await listDeals(ctx, viewer.companyId)).filter((deal) => deal.contactId === contact.id);
  const activities = await listActivities(ctx, "contact", contact.id, 20);
  return {
    contact: { id: contact.id, name: contact.name, lifecycle: contact.lifecycle, tags: contact.tags },
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
  const account = createAccount({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    domain: optionalString(params, "domain"),
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
  const account = await requireAccount(ctx, viewer, requiredString(params, "companyRecordId"));
  const result = applyFieldPatch({
    columns: {
      name: account.name,
      domain: account.domain,
      lifecycle: account.lifecycle,
      currency: account.currency,
      tags: account.tags,
    },
    custom: account.custom,
    humanOwned: account.humanOwned,
    columnKeys: columnKeysFor("company"),
    patch: patchFrom(params, ["name", "domain", "lifecycle", "currency", "tags"]),
    source,
  });
  normalizeAccountColumns(result.columns);
  account.name = String(result.columns.name ?? account.name);
  account.domain = (result.columns.domain as string | null) ?? null;
  account.lifecycle = assertLifecycle(String(result.columns.lifecycle ?? account.lifecycle));
  account.currency = assertCurrency(String(result.columns.currency ?? account.currency));
  account.tags = asStringList(result.columns.tags);
  account.custom = result.custom;
  await saveAccount(ctx, account);
  await insertFacts(ctx, account.companyId, "company", account.id, result.facts);
  return { ...account, refused: result.refused };
}

async function createContactRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = createContact({
    companyId: viewer.companyId,
    name: requiredString(params, "name"),
    emails: stringList(params, "emails"),
    phones: stringList(params, "phones"),
    lifecycle: optionalString(params, "lifecycle"),
    tags: stringList(params, "tags"),
    custom: customOf(params),
    nextActionKind: params.nextActionKind,
    nextActionDueAt: optionalString(params, "nextActionDueAt") ?? null,
    ownerUserId: viewer.userId,
    assigneeAgentId: viewer.agentId,
  });
  await insertContact(ctx, contact);
  return contact;
}

async function updateContact(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const contact = await requireContact(ctx, viewer, requiredString(params, "contactId"));
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
  return { ...contact, refused: result.refused };
}

async function linkRecords(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, requiredString(params, "contactId"));
  const account = await requireAccount(ctx, viewer, requiredString(params, "companyRecordId"));
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
  return link;
}

async function logActivity(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
  await requireRecord(ctx, viewer, recordType, recordId);
  const id = await insertActivity(ctx, {
    companyId: viewer.companyId,
    recordType,
    recordId,
    kind: optionalString(params, "kind") ?? "note",
    body: requiredString(params, "body"),
    issueId: optionalString(params, "issueId"),
  });
  return { id };
}

async function createDeal(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const pipeline = await ensurePipeline(ctx, viewer.companyId);
  const accountId = optionalString(params, "companyRecordId");
  const contactId = optionalString(params, "contactId");
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
  return deal;
}

async function moveDeal(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const deal = await requireDeal(ctx, viewer, requiredString(params, "dealId"));
  const stage = await getStage(ctx, requiredString(params, "stageId"));
  if (!stage || stage.company_id !== deal.companyId) throw new CrmError("Stage was not found");
  deal.stageId = stage.id;
  await saveDeal(ctx, deal);
  if (stageStopsEnrollments(stageKind(stage.kind)) && deal.contactId) {
    await stopEnrollmentsForContact(ctx, deal.companyId, deal.contactId);
  }
  return { ...deal, stageKind: stage.kind };
}

async function shareRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const recordType = assertRecordType(requiredString(params, "recordType"));
  const recordId = requiredString(params, "recordId");
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
    fieldType: optionalString(params, "fieldType") ?? "text",
  });
  return { fieldKey };
}

async function createSequence(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = randomUUID();
  const completionMode = completionModeOf(optionalString(params, "completionMode"));
  await insertSequence(ctx, { id, companyId: viewer.companyId, name: requiredString(params, "name"), completionMode });
  for (const step of stepsFrom(params)) {
    await insertStep(ctx, { companyId: viewer.companyId, sequenceId: id, step });
  }
  return { id, name: requiredString(params, "name"), completionMode };
}

async function enroll(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const contact = await requireContact(ctx, viewer, requiredString(params, "contactId"));
  const sequence = await getSequence(ctx, requiredString(params, "sequenceId"));
  if (!sequence || sequence.company_id !== viewer.companyId) throw new CrmError("Sequence was not found");
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

async function completeStep(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const enrollment = await enrollmentById(ctx, requiredString(params, "enrollmentId"));
  if (!enrollment || enrollment.companyId !== viewer.companyId) throw new CrmError("Enrollment was not found");
  if (enrollment.status !== "running") throw new CrmError("Enrollment is not running");
  await requireContact(ctx, viewer, enrollment.contactId);
  const sequence = await getSequence(ctx, enrollment.sequenceId);
  if (!sequence) throw new CrmError("Sequence was not found");
  const mode = completionModeOf(sequence.completion_mode);
  const issue = enrollment.openIssueId ? await ctx.issues.get(enrollment.openIssueId, viewer.companyId) : null;
  if (!canCompleteStep({ completionMode: mode, issueStatus: issue?.status ?? null, sentConfirmed: params.sentConfirmed === true })) {
    throw new CrmError(mode === "manual" ? "The sequence issue is not done yet" : "Confirm the message was sent before completing this step");
  }
  const steps = await listSteps(ctx, enrollment.sequenceId);
  const next = advanceEnrollment(enrollment, steps, new Date());
  await saveEnrollment(ctx, next);
  return next;
}

async function openDueSteps(ctx: PluginContext) {
  const due = await dueEnrollments(ctx);
  const assigneeModeByCompany = new Map<string, string>();
  for (const enrollment of due) {
    try {
      const steps = await listSteps(ctx, enrollment.sequenceId);
      const step = steps.find((item) => item.position === enrollment.stepPosition);
      const contact = await getContact(ctx, enrollment.contactId);
      if (!step || !contact) continue;
      if (!assigneeModeByCompany.has(enrollment.companyId)) {
        const config = await readConfig(ctx, enrollment.companyId);
        assigneeModeByCompany.set(enrollment.companyId, String(config.sequenceIssueAssignee ?? "contact"));
      }
      const assignToContact = assigneeModeByCompany.get(enrollment.companyId) !== "none";
      const copy = sequenceIssueCopy(contact.name, step);
      // Explicit companyId: jobs have no invocation scope, and the host only
      // allows a job's call for a company that has saved CRM settings.
      const issue = await createWorkIssue(ctx, {
        companyId: enrollment.companyId,
        title: copy.title,
        description: copy.description,
        originKind: "plugin:partnersinbiz.crm",
        originId: enrollment.id,
        ...(assignToContact && contact.assigneeAgentId
          ? { assigneeAgentId: contact.assigneeAgentId }
          : assignToContact && contact.ownerUserId && contact.ownerUserId !== LOCAL_BOARD_USER_ID
            ? { assigneeUserId: contact.ownerUserId }
            : {}),
        wakeReason: "CRM sequence step is due",
      });
      enrollment.openIssueId = issue.id;
      await saveEnrollment(ctx, enrollment);
    } catch (error) {
      ctx.logger.error("CRM due step failed", {
        enrollmentId: enrollment.id,
        companyId: enrollment.companyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
      await emitChanges(ctx, companyId, sinceSeconds);
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
  return { ok: true, ...counts };
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

async function onIssueUpdated(ctx: PluginContext, issueId: string | undefined, companyId: string) {
  if (!issueId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.status !== "done") return;
  const enrollment = await enrollmentByIssue(ctx, issue.id);
  if (!enrollment) return;
  const sequence = await getSequence(ctx, enrollment.sequenceId);
  if (!sequence || completionModeOf(sequence.completion_mode) !== "manual") return;
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

async function enrollmentById(ctx: PluginContext, id: string) {
  const rows = await ctx.db.query<{
    id: string;
    company_id: string;
    sequence_id: string;
    contact_id: string;
    status: "running" | "stopped" | "done";
    step_position: number;
    next_due_at: unknown;
    open_issue_id: string | null;
  }>(
    `SELECT id, company_id, sequence_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "enrollments")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    sequenceId: row.sequence_id,
    contactId: row.contact_id,
    status: row.status,
    stepPosition: row.step_position,
    nextDueAt: row.next_due_at == null ? null : String(row.next_due_at),
    openIssueId: row.open_issue_id,
  };
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

function toolContent(name: string, data: unknown): string {
  if (data && typeof data === "object" && "name" in data && typeof data.name === "string") return `${name}: ${data.name}`;
  if (data && typeof data === "object" && "title" in data && typeof data.title === "string") return `${name}: ${data.title}`;
  return name;
}
