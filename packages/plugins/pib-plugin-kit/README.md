# @partnersinbiz/pib-plugin-kit

Worker-side helpers shared by the Partners in Biz Paperclip plugins. The kit is **bundled into each plugin at build time** (esbuild), so a kit change reaches a plugin only when that plugin is rebuilt and redeployed.

Run `pnpm test && pnpm typecheck` here after any change. `pnpm test` also runs the cross-plugin contract tests in `contract/` (they read every plugin's sources).

## Where things are

| Module | What it holds |
|---|---|
| `cockpit.ts` | Snapshots, health checks, jobs tracking, **team roles** (`registerRoleWatch`, `companyRoles`, `readCompanyRoles`, `ownerUserFor`, `routeWork`), hand-off events |
| `approvals.ts` | **`resolveApprover`, `openApprovalIssue`, `unroutedApprovalsCheck`, `repairUnroutedApprovals`, `rolesCopyHealth`** (Q5-6) |
| `known-companies.ts`, `company.ts` | **`syncAllCompanies`, `registerCompanyBootstrap`, `skillSyncCheck`, `skillsBehind`** (Q7-2, Q7-12) |
| `run-profile.ts`, `team.ts`, `agent-hire.ts` | **Run profile per role**, `unpinnedRunProfileCheck`, hire task rows (Q8-7, Q9-7) |
| `role-drift.ts`, `grant-check.ts` | **`roleDriftCheck`**, plugin-tool access check (Q9-8, Q7-3, Q9-6, Q8-12) |
| `client-project.ts` | **`resolveClientProjectId`** and the CRM link projection (Q1a-12) |
| `ask-effects.ts`, `asking.ts` | **Ask effects** (an answer becomes an effect), ask-card lint, unblock descriptors (RC5) |
| `waiting.ts` | The waiting list nobody sees: unrouted approvals, blocked issues with no way out |
| `privacy.ts` | Consent and erasure contract (Q10-13) |
| `sender-scope.ts` | Per-sender suppression, sender identities, unsubscribe tokens (Q1a-3) |
| `skills.ts`, `memory.ts`, `agent-hire.ts`, `done-checks.ts`, `outbox.ts`, `flows.ts`, … | Unchanged helpers (see their headers) |

## Q5-6: why approvals opened unassigned (root cause)

The audit blamed the agent tool-call context. It was not the context. Evidence, all read-only:

* Every plugin holds a copy of the Cockpit's roles in state (`pib-cockpit/roles`), filled by `roles.updated` events (`registerRoleWatch`).
* Hourly DB dumps of 2026-09-30 10:36, 09-30 11:36 and 10-01 15:39 (25 minutes before PAR-456) show **every plugin's copy stuck on the first broadcast** of 2026-09-27 06:32:49: `ownerUserId: null`, `reviewOutward: false`. The rows were first rewritten at 2026-10-02 12:10 (the 08:38 dump still shows the old copy), after the fix shipped.
* Cause: the watch compared `updatedAt` as **text**. The first stamp was ISO (`2026-09-27T06:32:49.178Z`), every later one the host's Postgres text (`2026-09-27 18:46:11.052+00`). `"T"` sorts after `" "`, so each later broadcast looked older and was dropped (`"2026-09-27T06:32:49.178Z" > "2026-09-27 18:46:11.052+00"` is `true`). The Cockpit's `iso()` also leaked the Postgres form until 0.4.4.
* With no owner and no Reviewer in the copy, `approvalAssignee` (CRM) returned `{ reviewer: null, approverUserId: null }` and Accounting logged "Accounting issue has nobody to go to (no Bookkeeper, Operator or owner yet)" at the exact second of each unassigned approval (journal 09-30 10:37-10:55). That happened in **every** context.
* Why "outside a tool call" looked fine: Accounting's `approverFor` falls back to the clicking user, and a person using the UI has one; an agent actor has none. PAR-270..274, which did get the owner, were created with no agent tool call in the activity log (a person's action in the UI at 11:18, minutes after the owner cancelled the earlier ones).

What the kit does now:

1. `registerRoleWatch` compares moments (`rolesPayloadIsOlder`), stamps `receivedAt`, remembers the last owner it ever saw.
2. `companyRoles` repairs a missing owner from the host's own `Company.defaultResponsibleUserId` (needs only `companies.read`, which every PiB plugin has), so **every existing caller** that reads `.ownerUserId` is protected after a rebuild with no code change. `readCompanyRoles` gives the raw copy, its age and any read error (a failed read is logged, no longer swallowed).
3. `resolveApprover` / `openApprovalIssue` walk a chain that cannot end silently: Reviewer (outward work, when the company reviews it) -> owner from the roles copy -> the company's default responsible user -> the person who triggered it -> the last owner seen -> the Operator (asks the owner) -> **unrouted, loudly** (the issue says so, the worker logs a warning, `unroutedApprovalsCheck` goes red). A host that refuses an assignee falls through to the next route.

```ts
// Replaces the plugin's own reviewer/owner lookup and createWorkIssue call:
const approval = await openApprovalIssue(ctx, {
  companyId, title: `Approve email sending: ${name}`, description,
  originKind: `plugin:${PLUGIN_ID}`, originId: originFor.sequenceEmail(id),
  outward: true,                       // the Reviewer checks first when the company reviews outward work
  actorUserId: viewer.userId,          // a person who triggered it from a page, if any
  reviewerBrief: (route) => approvalReviewerBrief(route, `sequence "${name}"`, CHECKS),
});
// approval.assignedTo: "reviewer" | "person" | "operator" | "nobody"
```

Cockpit wiring (the Cockpit builder): add `await unroutedApprovalsCheck(ctx, companyId)` and `rolesCopyHealth(ctx, companyId)` to its health list, and `repairUnroutedApprovals` to an hourly job that already acts for the company.

## Every company, not only the one a call comes from (Q7-2, Q7-12)

What the host allows bounds what is possible (wiki `plugin-jobs-company-scope`):

* A job's host call passes only for a company with a **saved plugin config row**. A company whose plugin settings were never saved (Partners in Apps today) is refused with "company context is required". So **a job cannot sync skills for such a company; it can only report `needs_settings`**. Nothing in a plugin can lift that without a host change.
* A tool, action or event for a company runs with that company's scope whether configured or not. That is why `company.created` works, and why the lazy events below can catch up a company nobody configured.
* `ctx.companies.list` is refused while any other call is in flight in the worker (hundreds of refusals in the journal). Company ids come from the plugin's own memory (`knownCompanyIds`, instance-scoped state, written by every `createSkillSyncer` call), merged with a best-effort host list.

```ts
// setup(): replaces ctx.events.on("company.created", ...)
const syncer = createSkillSyncer(ctx, SKILLS);
registerCompanyBootstrap(ctx, { syncer, ensureResources: (id) => ensureManagedProject(ctx, id), ownerIssue: false });
// In exactly ONE plugin (Setup): ownerIssue: {} opens "Set up <company>" with a Setup -> Team deep link, once per company.

// An hourly job the plugin already has (or register SKILL_SYNC_JOB in the manifest and call registerSkillSyncJob):
await syncAllCompanies(ctx, syncer, { companyIds: await companiesFromMyRows(), isEnabled: (id) => isModuleEnabled(ctx, id, PLUGIN_ID), plugin: PLUGIN_ID });
```

`registerCompanyBootstrap` also runs lazily (once per worker, retried after an error) on `company.updated` and `project.created` for a company that never saw `company.created`. It deliberately does not listen to `agent.created`: `registerHireWatch` already subscribes to the agent events in six plugins, the host runs every handler subscribed to a name on each delivery, and a second one would run twice. `skillSyncCheck(ctx, companyId, "CRM")` tells the Cockpit which company needs its settings saved; `skillsBehind` says which skills a company has not received at their current version.

`contract/company-created-contract.spec.ts` fails when a plugin with skills neither handles `company.created` nor is in `EXEMPT` (today only `cockpit`; remove it once the Cockpit uses `registerCompanyBootstrap`), when a plugin subscribes twice to `company.created`, or when a plugin reads the roles copy without `registerRoleWatch`. A second contract, "core event subscriptions", fails when a plugin has two handlers for the same core event name (counting what `registerHireWatch`, `registerDoneChecks` and `registerCompanyBootstrap` subscribe to for it).

## Run profile per role (Q8-7, Q9-7)

`RUN_PROFILES` gives every `TeamRole` a `runProfile` (model, effort, timeoutSec, maxTurnsPerRun, maxConcurrentRuns). Defaults: Sonnet for everything that writes to customers, money or the books; the Reviewer is Sonnet (the quality gate), never Haiku; Haiku / DeepSeek flash only for the Inbound Qualifier, CRM Data Steward and Sales Lead; timeout never 0 (the host reads 0 as unlimited); SEO runs 6 at once, the rest 3-4. A `HireRole` may set its own `runProfile`; otherwise `runProfileForRole(roleKey)`.

`hireTaskDraft` prints the profile as table rows plus the exact JSON to set. **A plugin cannot write an agent's settings after the hire** (`ctx.agents` reads, pauses, resumes and invokes only), so the profile travels in the hire task for the CEO or the person to set. For an existing agent it is a board action: `PATCH /api/agents/<id>` with the **full** `adapterConfig` (the payload replaces it). `unpinnedRunProfileCheck(agents)` flags `claude_local` agents with no model (they fall to Opus), no timeout (0 or unset is unlimited) or a turn cap of 1000.

## Skills and tool access that agents actually hold (Q9-8, Q7-3, Q9-6, Q8-12)

`roleDriftCheck(ctx, companyId)` compares each staffed kit role's expected skills (and optional extras) and plugin-tools grant with the agent's `desiredSkills` and grants, and returns problems like "Bookkeeper (Bookkeeper) lacks skill plugin/.../bookkeeping (attach in Setup -> Team)". A plugin cannot attach skills (no SDK call); the fix text names the board action. `agentsWithoutPluginTools` / `pluginToolsGrantCheck` / `toolsGrantWaitingItem` find agents that carry PiB skills but cannot call the company-memory tools (so they never recall memory) and produce ONE batched Needs-you item.

**The grant need not be wide.** The live host enforces `tools:use` scopes with exact `toolNames` and an `allow` list (`tool:<name>`), not only the provider type (host `tool-access-policy` `scopeAllowsTool`). So the recommended fix is the memory-only grant `MEMORY_TOOLS_GRANT` (`{ toolNames: [memory-recall, memory-search, memory-add, memory-feedback] }`, exact names, no wildcards): it opens no CRM, billing or payroll tool. All plugin tools (`PLUGIN_TOOLS_GRANT`) is the alternative, only for an agent that works in the modules. The checks take the tools an agent needs (`requiredTools`, default `MEMORY_AGENT_TOOLS`) and read the real scope (`scopeAllowsTool`, `toolsMissing`), so a memory-only grant satisfies them; `roleDriftCheck` treats a narrowed grant that includes memory as informational only. The Agents -> Permissions page has no field for named tools, so the kit also ships the way to apply it: `memoryGrantAsk(problems)` builds the ask (a grant card with a deep link and steps, passes `askCardProblems`) carrying the effect `MEMORY_GRANT_EFFECT_KEY`, and `memoryGrantEffect` is the handler: register it in the Cockpit (`authorization.grants.write`) with `registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect)` and run it with `runAskEffect` on the Cockpit's own asks (no event needed). It validates that every agent id is an active agent of this company, writes only the fixed memory grant (never taken from the params), refuses to widen a grant someone limited another way (`conflict`, for a person) and reads the grants back. `applyMemoryToolsGrant` and `mergeMemoryToolsGrant` are the pieces.

## Client work goes in the client's project (Q1a-12)

`resolveClientProjectId(ctx, companyId, scope, { fallbackProjectId })` returns the client's own Paperclip project from the CRM's `client_projects` links, else the plugin's own project, **never another client's**. Consumers call `registerClientProjectWatch(ctx)` once.

**Contract the CRM must publish** (the CRM builder): emit `client.projects.updated` with `{ clientKind, clientRef, projectIds: string[], updatedAt }` (the client's FULL list, `[]` after the last unlink) after `link-client-project` and `unlink-client-project`, and re-emit every client's list in the hourly job that re-emits sites and from the `resync` action. Ids only.

## Asks that do something, and blocks with a way out (RC5)

Loop: agent asks (`ask-owner` with `effect: { key, params }`) -> owner answers -> the Cockpit emits `ask.answered` (`emitAskAnswered`) -> the plugin that registered the key (`registerAskEffect` + `installAskEffects`) applies it, **reads it back** (`verify`) and emits `ask.effect.result` -> the Cockpit posts `askEffectComment` ("Applied and checked: ...") and wakes the agent. Idempotent on both sides; a failed or unverified effect is never reported as applied, and `classifyAskAnswer` applies nothing on an unclear answer ("yes but only read", "yes, and also send").

**An effect can be a permission grant, and its key and params are chosen by the agent that asked.** Two safety rules are in the code, and the builders on each side must keep to them:

* An effect runs only for an answer a person gave. `AskAnswered.answeredByUserId` is a required string; `runAskEffect` returns `refused` (handler never called, nothing stored) when it is empty, the board sentinel (`local-board`) or the asking agent itself, and an `ask.answered` event without it gets a `refused` result so the Cockpit stops re-announcing. The Cockpit must emit only for a reply by the owner or another company member, never for the asking agent's own comment, and must print the effect on the card the owner answers (`describeAskEffect(effect)`: "Runs mailbox.delegate with accountId=..., scope=... when you say yes.").
* The handler must not trust the params. Whitelist and re-validate them in `validate` (`checkEffectParams` rejects unknown keys, wrong types and values outside a list; the handler still checks that the account belongs to this company, the scope is in an allowed list and the target agent is in this company). A refused validation applies nothing and stores nothing.

```ts
registerAskEffect("mailbox.delegate", {
  apply: async ({ ctx, companyId, ask }) => { /* create the delegation */ return { detail: "The Operator can now read and draft on acc-1." }; },
  verify: async ({ ctx, companyId, ask }) => /* read the delegation back */ true,
});
installAskEffects(ctx); // in setup, after the registrations
```

`askCardProblems(card)` is the lint the Cockpit's `ask-owner` applies: at least one link, a grant/money/legal ask links the exact screen (not only the issue), a grant carries steps, an effect is only on a grant or decision. For blocks: `blockedComment` / `parseBlockedComment` / `unblockPath(issue)`; the asking section in every skill now says "name what unblocks it (`unblockDescriptor`) or ask". `listBlockedIssues` / `blockedWithoutPathCheck` / `waitingBacklog` find the invisible waiting list (blocked issues with no descriptor, blocker, ask or person holding them; unassigned approvals) and turn it into Needs-you items.

**Reading the blockers needs a lookup the plugin can actually make.** The host's issue list carries no blocker relations, and `ctx.issues.relations.get` needs the capability `issue.relations.read`, which no PiB plugin declares (declaring it would force a stop-first deploy). So `listBlockedIssues` takes `blockedBy`, a lookup returning which issues have an open blocker; the Cockpit has `issue_relations` and `issues` in its `coreReadTables`, so it passes `blockedBy: dbBlockedByLookup(ctx)` (company-scoped SQL, no new capability). Without a lookup and without the capability every issue that has no descriptor and no ask is `unknown`: never escalated, and now **visible**: `blockersUnreadableCheck(rows)` is a warning ("N blocked issues cannot be checked") and `waitingBacklog().blockedUnknown` lists them, so a blind plugin no longer looks like a company with nothing stuck. The host's list also lacks the retry and recovery fields, so a block waiting on a pending interaction shows only through the 24 h threshold; the Cockpit's own watch rule (`WATCH.blockedHours`) escalates a block with no way out after 24 h today.

## Consent and erasure (Q10-13) and sender scope (Q1a-3)

`privacy.ts`: events `consent.recorded`, `contact.erase.requested`, `contact.erase.completed` (in `HANDOFF_EVENTS`), payload types, `registerEraseReceiver` (at most once per request, refuses without `approvedByUserId`, a failure stores nothing so the next announcement retries, legal retention reported not erased), and the sender-side ledger (`startErasure`, `recordEraseResult`, `reannounceErasures`, `eraseSummary`). The ledger keeps the subject's email and phone only while a participant still has to erase; when every participant has answered it keeps a SHA-256 of the subject key (`subjectHash`) and drops the identifiers (`redactLedgerEntry`). A participant that never answers (no receiver registered, or failing) keeps the request open: `staleErasuresCheck` warns after 7 days and goes red past `dueBy`, naming the request and plugins, never the person. `sender-scope.ts`: `senderKeyOf`, `suppressionBlocks` (an unsubscribe is per sender, a hard bounce blocks all, legacy rows with no sender keep blocking everyone's marketing), `resolveSender` (a client's mail is refused rather than sent from the default account), `mailSenderFields`, signed one-click unsubscribe tokens. `MailSendRequested` gained optional `fromName`, `replyTo`, `unsubscribeUrl`.

## Mail delivery and signed-document hand-offs (0.2.2)

Small and additive; nothing here changes what a plugin already sends or reads.

* **`MAIL_EVENTS.delivery`** (`mail.delivery`, full name `plugin.partnersinbiz.mailbox.mail.delivery`) and the type **`MailDelivery`**: what the Mailbox announces after an email provider took a message. `type` is one of `MAIL_DELIVERY_TYPES` (`delivered`, `delayed`, `bounced`, `soft_bounced`, `complained`, `failed`, `suppressed`, `opened`, `clicked`), with the send's `sendKey` (the `MailSendRequested.key`; null when the Mailbox cannot tie the event to a send of its own), the `provider`, the time `at`, the send's `context`, the client scope (`clientKind`/`clientRef`: the send's own, else the sending domain's) and, for a bounce, `bounce: { kind: "hard" | "soft", subType }`. `key` is `esp:<the provider's delivery id>`: the same delivery twice carries the same key, so a consumer dedupes on it (`receiveOnce`). It is not a second `mail.send.result`: a send settles on its one result, and a later bounce is only ever this event. No message content and no link, so it is safe to log. `opened` and `clicked` exist only when somebody switched tracking on for the sending domain at the provider; each may repeat, so count the first per `sendKey`.
* **`MailSendResult.provider`** (optional, `resend` for a send through the email provider, absent for Gmail) and **`MailSendResult.replyTo`** (optional: the Reply-To the message went out with). A provider send has no Gmail `threadId` or Message-ID, so a sender that wants to attribute a later reply to its own record keeps `replyTo` and the send's key (Campaigns does).
* **`HANDOFF_EVENTS.dealAccepted`** (`deal.accepted`, full name `plugin.partnersinbiz.crm.deal.accepted`) and **`DealAccepted`**: the CRM sends it when a client signs a document on the e-sign page (CRM README, "After a signature"). The shape is the CRM's, field for field (`DEAL_ACCEPTED_FIELDS` lists them); `key` is `crm:esign:<documentId>:accepted`, recorded once and re-sent hourly for a day, so a receiver dedupes by `key`. A signed quote also goes out as `quote.accepted` in the shape Billing already reads. The cross-plugin contract test `contract/crm-deal-accepted-contract.spec.ts` reads the CRM's source and fails when the CRM's hand-off and this type disagree (a field added or dropped on one side only).
* The names follow the existing convention: `HANDOFF_EVENTS` and `MAIL_EVENTS` hold the bare event name and `pluginEvent(PIB_PLUGINS.<sender>, name)` builds the full one a receiver listens to.

## Budgets and rules to keep

* Skills stay <= 18,000 characters; the Cockpit manual <= 16,000. The Cockpit Operator skill sits at 17,944 against its own test's 17,950, so the shared asking section was rewritten to grow by 3 characters only. Any further growth of `ASKING_SECTION` needs room made in the Cockpit skills first (move reference material into the skill's references).
* Never edit an applied migration. The kit adds none: all new state is plugin state (instance or company scoped, namespaces `pib-kit`, `pib-privacy`, `pib-cockpit`).
* No new capabilities are needed. Optional ones the new code uses when present: `companies.read` (all plugins have it), `agents.read`, `authorization.grants.read`, `authorization.grants.write` (only the plugin that registers `memoryGrantEffect`, the Cockpit), `projects.read` (Social and Campaigns do not declare it, so `resolveClientProjectId` there trusts a linked project it cannot verify as live), `issues.read`. Reading blocker relations through the SDK would need `issue.relations.read`, which no plugin has: use `dbBlockedByLookup` (needs `database.namespace.read` and `issue_relations` + `issues` in `coreReadTables`, which the Cockpit has).
