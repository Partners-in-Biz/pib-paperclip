/**
 * The Operator skill's reference files (progressive disclosure): the skill body
 * keeps the daily and weekly loops and the rules; what to do for each kind of
 * health check, how to work a close-out or business review, the improvements
 * ledger, goals, credentials and asking with an effect live here and are read
 * when a check or an issue calls for them. They ship with the skill (`files`),
 * so a change to any of them changes the skill's version and every company's
 * copy is brought up to date.
 *
 * Tool names are built from the declarations, so a renamed tool cannot leave a
 * reference pointing at nothing (a test checks every name exists).
 */
import { MEMORY_TOOLS } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_KEY } from "./constants.js";
import { EVAL_TOOL_NAMES } from "./eval-tool-declarations.js";
import { OPS_TOOL_NAMES } from "./ops-tool-declarations.js";
import { TOOL_NAMES } from "./tools.js";

const T = (name: string) => `\`${PLUGIN_KEY}:${name}\``;

export const OPERATOR_REFERENCE_PATHS = {
  health: "references/health-checks.md",
  closeout: "references/closeout-review.md",
  retro: "references/retro-and-improvements.md",
  goals: "references/goals-and-business-review.md",
  credentials: "references/credentials-and-custody.md",
  asking: "references/asking-with-an-effect.md",
  quality: "references/quality-gates.md",
  coach: "references/skill-coach.md",
} as const;

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

export const HEALTH_REFERENCE = `# Acting on health checks

Each check has a \`detail\` (what is wrong), a \`fix\` and an \`href\`. Do what an agent can do. What only a person can do (a key, a login, a setting in Setup, money) goes on the brief once, with the link. Never close the System health issue to make a check go away.

## Failing work

- **Routine "…" failed its last run**: a schedule fired but created no issue, so that work did not happen. Read why: \`GET /api/routines/{id}/runs\` (any agent; the id is in \`href\`). A plugin bug (the check names it; the log shows a database or id error in the plugin's own code, not a setting) goes to the role that owns code, or the owner if none: \`${T(TOOL_NAMES.askOwner)}\` (kind \`decision\`, on System health) naming the plugin, routine and error; anything else (assignee paused, workspace) you fix. To run it again, only its assignee may \`POST /api/routines/{id}/run\` (you, for the Cockpit's own routines), so open an issue for the assignee: "Run <routine> once now and report". The check clears when a run creates its issue, or at the next schedule.
- **An agent failing** ("failed N% of its runs", "N times in a row with <code>", "<issue> keeps failing"): read the latest failed run's error. The same error each time: never just retry; fix the cause or change the work: \`spawn E2BIG\` means the thread is too long (close it and open a continuation issue with a short summary); \`workspace_validation_failed\` means the project's workspace is not set up; a timeout means split the task. Set a storming issue aside (daily step 5) until it is fixed.
- **N issues are in progress with nobody working on them** (the assignee is idle and has had no run for 12 hours): comment what to do next to wake it; if it cannot act, reassign it to the role that owns the work; if done, close it with evidence (daily step 5).
- Agent **in error**: read its last run (\`GET /api/companies/{companyId}/heartbeat-runs?agentId=…&limit=5\`). If an agent can fix the cause, hand it off; a key, a login or money goes on the brief.
- Agent at **80%+ of its budget**: check what it spent on and narrow its work (pause low-value routines). Never raise a budget (the owner's call): put it on the brief with the numbers. Budgets count billed cents and the flat Claude plan bills none, so a quiet budget says nothing about load: use notional spend (below).
- **Plugin not reporting**: check the plugin is on and its settings are saved (Setup page). If a person must act, it goes on the brief.
- **Daily close-out reviews**, **Daily improvements re-check**, **Daily credentials check**, **Weekly business review** (a Cockpit job): the job stopped, or failed for every company it tried. Nothing else says so (reviews stay unopened, improvements unmeasured, expiries unwatched). Read the detail: usually the plugin is not ready or a settings save is missing; a person fixes that: brief.
- The **System health** issue is kept up to date for you (warnings join it after a day). Comment on it with what you did; it closes itself when everything is ok (closing it yourself reopens it).
- **Finished code with no proof**, **outward approvals never reviewed**, **acceptance journeys failing**, skill evals: \`${OPERATOR_REFERENCE_PATHS.quality}\`.

## Who can do what

- **"<agent> (<role>) lacks skill …"**, **"…has no plugin tool access"**: an agent holds a role but cannot do it. Only the owner can fix it: Setup → Team (Fix skills, or save the role again, which grants plugin tools). Put it on the brief with \`/<prefix>/setup?section=team\`; never grant tools yourself.
- **Agents with no run profile**: an agent has no pinned model or run timeout, so it can run on the default model and stall on a long task. A plugin cannot change an agent: the owner sets them under the agent's Configuration. Brief, once.
- **Agents that cannot use company memory**: the Cockpit has already put one question to the owner (a yes grants the four memory tools and checks it). Do not ask again.
- **Approvals with nobody to decide them**: the hourly repair hands them to the owner. If the check stays red, the owner is probably not set: Setup → Team. Brief.
- **N issues are blocked with no way out**: the check says exactly what each lacks (an unblock owner and action, a blocker issue, a question to the owner). One whose blockers are all done only has to be moved on: set it \`todo\` and wake the assignee. Give the rest their way out (daily step 5).
- **Blocked issues that wait on an agent that cannot act**: the descriptor names an agent that is paused, removed or in error. Give the issue a new owner (\`PATCH /api/issues/{id}\` with \`unblockDescriptor\`), or put the agent on the brief for the owner to fix in Setup → Team.

## Spend, plan limits and quality

- **Notional spend** is what the tokens would cost at list price, from the runs' usage. It is not billed: a flat plan has no dollars to run out of, but notional spend shows how hard the agents work and how near the plan's limit is. The Cockpit settings can set a daily and a weekly limit; never raise one yourself.
- **Notional AI spend is $N in 24 hours / this week**, **N times the usual**: run ${T(OPS_TOOL_NAMES.measure)} and find the agent, project or issue tree that used it. Then narrow it: split the task, close a looping issue, pause a low-value routine. Put the cause on the brief in one line.
- **N runs failed on the subscription limit**: the plan's usage limit stopped runs, and every agent fails until the window resets. Never retry. Pause the lowest-value routines, keep the Operator and Reviewer running, and put it on the brief (the plan is the owner's call).
- **Only N% of finished code work was reviewed**: a done code issue counts as reviewed when its execution policy has an approved review stage, or an issue assigned to a Reviewer is linked to it (a child, a blocks relation, or its identifier in the title or description). Hand the listed work to the Reviewer, and send code work for review before it is closed from now on. Say the coverage in the retro.
- **<client>: agent effort is N% of what they paid** (or "nothing paid in 30 days"): effort is notional spend on the client's projects set against invoices paid in the last 30 days (Billing does not publish retainer amounts, so a prepaid client can look worse than it is). Put the numbers on the brief and propose how to narrow repeated work. Never stop client-facing work without telling the owner. A customer with nothing paid: the Account Manager checks the invoice.

## Registers, confirmations and the owner's queue

- **<credential> expires in N days / expired**, **<system> refused <credential>**, **N credentials exposed and not yet replaced**: \`${OPERATOR_REFERENCE_PATHS.credentials}\`.
- **Confirm board sign-up is closed**, **Confirm the backup key is stored outside your Mac**, **Confirm a second break-glass admin…**, **Confirm the Mac that holds the keys is backed up**, **Only one person can administer this company**: only the owner can confirm these (a button in Setup). \`${OPERATOR_REFERENCE_PATHS.credentials}\`.
- **N things wait on the owner, the oldest for N days**: the owner's queue (questions, approvals, blocked issues nothing can wake, issues assigned to them) is too big or too old. Work it down yourself: answer what the context answers, hand back what an agent can do, and keep only money, legal, one-time grants and judgement. Batch what is left on the brief with the recommended answer first.
- **N questions to the owner have gone unhandled for 3 days**: nobody chased or answered them. Answer from context if you can; otherwise put them first on the brief with the answer you recommend.
- **N improvements past the re-check date**: record the number or drop the improvement (\`${OPERATOR_REFERENCE_PATHS.retro}\`).
- **<Plugin> skills not synced**: that plugin's settings are not saved for the company, so its agents keep old skills. The owner saves the plugin's settings once (Settings → Plugins). Brief.
`;

// ---------------------------------------------------------------------------
// Close-out review
// ---------------------------------------------------------------------------

export const CLOSEOUT_REFERENCE = `# Close-out review

Finished work is reviewed once so the next piece of work runs better. The Cockpit opens **Close-out review: <work>** for you, with the numbers already in the issue.

## When one is opened

- A project is set to \`completed\`, or finishes by itself (at least 3 issues, all done or cancelled, nothing changed for 3 days).
- An epic closes: its own issue is done, at least 3 issues sit under it and every one is closed.
- An evergreen project (40 or more issues, or work spread over 6 weeks or more, so never "finished") reaches a milestone: 40 more issues of real work closed since the last review (and at least 14 days after it), or 30 days with at least 5 closed. Routine runs and plugin housekeeping, such as the LLM Wiki's operations, are never counted.
- A daily sweep catches what the events missed, at most 3 a company a day, and nothing finished more than 45 days ago.
- You can open one for work you judge done: ${T(OPS_TOOL_NAMES.closeout)} with \`projectId\` or \`issueId\` (an epic). One review per project or epic per day.

## What is in the issue

How it ran: issues, runs (succeeded, failed, cancelled), retries, continuation wakes, how often a comment reopened work, blocked days, agent hours, typical and slow run time, tokens, notional spend and cost per finished issue, plan-limit failures. Who worked on it: each agent's spend, runs and skills. Spend is notional (list price), not a bill.

## How to work it

1. **Read the evidence.** Open the costliest and the most-retried issues and write three lines on what slowed or wasted the work: unclear briefs, a missing tool, a skill that lacked a rule, work that bounced between agents, an agent on the wrong model.
2. **Decide what to change.** Each change (a skill, an instruction, a routine, a plugin, who does what) is recorded with ${T(OPS_TOOL_NAMES.improvementPropose)}: the number it should move (a company or agent metric, or a number a module reports), where it stands now (measured for you when the Cockpit reads it), the target, the owner and when to look again. "Nothing to change" is a valid answer: say why. Hand the work of making the change to the agent that owns it.
3. **Record what was learned.** **Learned:** lines for lasting lessons. A lesson that is really a rule for a tool belongs in that tool's skill (improvement-propose with \`sourceFactId\`), not in every brief.
4. **Close the project** in Paperclip when no more work is planned (the checklist gives the call).
5. **Close this issue** with one line: efficient, acceptable or wasteful, the two numbers that say so, and the changes you recorded.

Tick each checklist line (\`- [x]\`) or comment \`Skipped: <item>, because <why>\`. Closed with lines open, the Cockpit reopens the issue and lists what is missing. A review is about how the work ran, never about blame, and never a reason to stop client work: the owner decides that.
`;

// ---------------------------------------------------------------------------
// Retro, measures, improvements
// ---------------------------------------------------------------------------

export const RETRO_REFERENCE = `# The weekly retro, the measure report and the improvements ledger

## Measure report

${T(OPS_TOOL_NAMES.measure)} (\`windowHours: 168\`; add \`parts: ["clients"]\` for effort against what each customer paid) answers what the week cost and how it went:

- **Notional spend and tokens**, per agent, project and issue tree: list-price dollars from the runs' usage (not billed; budgets stay empty on the flat plan), the costliest trees and the agents on them.
- **Cost per finished issue**: notional spend over issues closed in the window. Compare it with last week's, and a cheap agent against a costly one on similar work.
- **Run time** (typical and slowest 10%), **retries**, **continuation wakes**, **reopened by a comment**, and **why runs were cancelled** (for example \`workspace_busy\`). Failures by code. Many retries or reopenings are the first sign of unclear briefs.
- **Runs that hit the plan limit**, and the last day's spend against the usual.
- **Review coverage and latency**: how many finished code issues had a review, and how long it took.

Read it for causes, not totals: name the agent, the issue tree or the skill gap behind the biggest number, and propose one change for it.

## Improvements ledger

An improvement is a change to how the system or an agent works, written down with the number it should move. ${T(OPS_TOOL_NAMES.improvementPropose)} takes the title, what kind (skill, instruction, routine, plugin, agent, system), what is changed, the metric, the target, the owner and the re-check (default 14 days). For a metric the Cockpit reads (\`company:<metric>\`, \`agent:<id>:<metric>\`, \`kpi:<plugin>:<key>\`) the baseline is measured when you propose it; for \`manual\` you give it. The target must be on the better side of the baseline.

On the re-check date the Cockpit measures again and writes **improved**, **no change** (within 5%) or **worse** with both numbers; an unreadable number stays open and is retried. A manual one waits for you: ${T(OPS_TOOL_NAMES.improvementResolve)} with \`resultValue\`. An improvement more than 3 days past its date is **overdue**: record the number, or drop it with \`drop: true\`.

Each week, in the retro: ${T(OPS_TOOL_NAMES.improvementList)}, the brief's \`improvements\` (overdue first, then due, then the latest outcomes). Say which improved, which did not move and which got worse, and what you do about the last two: a change that made things worse is reverted or reworked, not left. Every proposal in the retro and every close-out review is recorded here; a proposal with no number is a wish.

### Pinned facts that describe a tool

A company-wide fact that is really a rule for a tool (for example "always pass the client when you call partnersinbiz.seo tools") rides in every brief and costs tokens each time. The Cockpit opens an improvement named "Fold into the <module> skill: …" for such facts, a few a day. Hand it to the agent that owns code (a plugin skill change, deployed). Once the skill carries the rule, ${T(OPS_TOOL_NAMES.improvementResolve)} with \`archiveFact: true\` archives the fact, and the count of pinned tool facts falls. This works after the re-check has already recorded its verdict (the re-check does not wait for the skill change): the verdict stays, the fact is archived.

## Company memory in the retro

Call ${T(MEMORY_TOOLS.review)}:

- Likely duplicates: keep the clearer fact and mark the other superseded (${T(MEMORY_TOOLS.update)} with \`status: "superseded"\` and \`supersededBy\`).
- Noisy facts (often in briefs but not useful): rewrite them to be specific, or archive them. Wrong facts: fix or archive.
- Company-wide facts that name a client (\`misfiled\`): they reach every client's brief. Move each with its \`suggestion\` (${T(MEMORY_TOOLS.add)} with that client and \`supersedes\`).
- Missing-fact reports: when the same kind of knowledge keeps being missed, save it, or tell the agents in the retro to save that kind of fact.

## Memory feedback

${T(MEMORY_TOOLS.review)} returns \`feedbackSignal\`: how many of the last 30 days' briefs got any feedback (missing, noise, wrong or **helpful**). Agents are prompted to leave one line after each task with ${T(MEMORY_TOOLS.feedback)}, a helpful one included.

- **NO SIGNAL** (none of the briefs got feedback) means nobody reported. It is not good news: never count it under what worked, never say how smart matching compares with the keyword baseline. Say the coverage, and ask the agents in the retro to leave feedback.
- **Thin signal** (under 20%, or fewer than 10 briefs): what was reported is real, but absence of a report proves little.
- Otherwise read the missing, noise and helpful counts and act on them (the memory step of the retro).

## Writing the retro

On this week's Daily brief issue, headed **Weekly retro**: what worked; what failed (from the measure report, not only failed runs); one scorecard line per agent (runs, failures, notional spend, cost per finished issue, the quality metric that matters most); one line on memory (facts, briefs, feedback coverage and its signal); one line on improvements (open, overdue, outcomes); one line on goals (\`${OPERATOR_REFERENCE_PATHS.goals}\`); at most 3 proposals, each recorded with improvement-propose, those needing the owner's yes marked.
`;

// ---------------------------------------------------------------------------
// Goals and the business review
// ---------------------------------------------------------------------------

export const GOALS_REFERENCE = `# Company goals and the weekly business review

The agents' scorecards say how the agents did. Goals say how the business did: leads, keyword rank, posts published, revenue received.

## Goals

A goal is a number to reach: a metric key, a target, which way is better and a period (week, month, quarter, year), optionally a due date. Targets live in the Cockpit (the host's goals have no target fields); each confirmed goal is also mirrored to Paperclip's goals.

- ${T(OPS_TOOL_NAMES.goalList)} with \`sources: true\` lists the numbers a goal can be based on: the Cockpit's own measures and every number a module reports now (new leads this week, keywords in the top 10, posts published, money received).
- ${T(OPS_TOOL_NAMES.goalSet)} proposes one: title, \`metricKey\`, \`targetValue\`, \`period\`, \`unit\`. It measures where the number stands now, and refuses a target that is already met or points the wrong way. Aim for about 3 goals; never more than 12 open.
- **Your goals are proposals.** The Cockpit puts ONE question to the owner for all of them together (an answer of yes activates them). Do not ask yourself, and do not ask again while one is open. Changing the target of an active goal makes it a proposal again.
- A goal measured by hand (\`metricKey: "manual"\`) needs this week's actual: goal-set with \`id\` and \`value\`.
- Propose goals from what the modules report, not from guesses. No goals yet: propose about 3 from the numbers in \`sources\` (the Setup checklist asks the owner for them too).

## The business review

Every Monday, before the retro, the Cockpit records each active goal's value and opens **Business review: week of <date>** for you: the goals against their numbers (reached, on track at 80% or more of the way, behind, or no number) with a checklist.

1. For each goal that is **behind**: find the cause in the modules' numbers, name the change that moves it, hand it to the agent that owns it (a Hand-off issue, and record it with improvement-propose when it has a number to move), and say when you will look again.
2. For each goal with **no number**: fix the source, or record it by hand.
3. Nothing behind: say in one line what drove the best number, and whether a target should be raised (one question to the owner, if so).
4. Close the issue with one line per behind goal: the cause and the change handed off. A one-off goal with a due date is marked reached when it is, and missed when the date passes first.

Tick each line or comment \`Skipped: <item>, because <why>\`: closed with lines open, the issue reopens.
`;

// ---------------------------------------------------------------------------
// Credentials and custody
// ---------------------------------------------------------------------------

export const CREDENTIALS_REFERENCE = `# Credentials and what only the owner can confirm

## The register

${T(OPS_TOOL_NAMES.credentialList)} lists every credential the company depends on: name, system, where it lives, owner, when it expires, how to rotate it and when it was last checked. It holds **names and places only, never a value**: ${T(OPS_TOOL_NAMES.credentialRecord)} refuses text that looks like a secret, so say where a secret lives ("PAR company secret GITHUB_TOKEN"), never what it is. In Partners in Biz's own company only (the owner ticks "Load Partners in Biz's own credentials list" in its Cockpit settings) the Cockpit seeds the register from the server's security table: GitHub tokens, the Claude login, API keys, Cloudflare and storage tokens, Resend, Google and LinkedIn apps, the board token, the backup key, the SSH keys. A client company's register starts empty and holds that client's own credentials only: never copy PiB's entries into it. Rows marked **burned** were published or leaked: they stay a warning until each is revoked and retired.

Alerts come at **30 days** (warn) and **7 days** or past (bad) before an expiry, when a provider **refuses** a credential, and while exposed credentials are not replaced. Where a company secret is picked under Credential checks in the Cockpit settings (GitHub, Cloudflare, Resend), the daily job asks the provider once whether the credential still works and learns GitHub's and Cloudflare's own expiry date. With \`verify: true\`, credential-list checks right now.

## What you do

- **Expiry warning:** rotating is the owner's (a new token in the provider's console). Put it on the brief once with the check's rotate link. When the new credential is in place, record it: credential-record with \`id\`, the new \`expiresAt\` and \`markVerified: true\`. Never paste the value anywhere.
- **Refused:** it is expired, revoked or wrong, so what uses it is failing now. Treat it as urgent on the brief, with the rotate steps.
- **Unknown expiry:** a row with no date is not safe, only unknown. When anyone learns the date, record it.
- **A new credential** (a key, a token, a service account) is added with credential-record: name, system, where it lives, owner, expiry, how to rotate. Any agent may add one or fix its details; **only you, the Operator, may mark one verified (\`markVerified\`) or change its status** (retire one that is gone, mark one that leaked \`burned\`), because those clear the alerts. When another agent finds a credential changed, it records the details and hands you the rest. Never mark a refused credential verified to quiet the alert: rotate it, and the next daily check clears it. credential-list with \`verify: true\` does not call a provider again for a credential checked in the last 15 minutes.

## Only the owner can confirm these

Four facts are not visible to the Cockpit, so each is an owner confirmation: a Confirm button on its Setup item and a health warning until it is given, asked again after 180 days.

- **Board sign-up is closed** (otherwise anyone can create an account on the board). The setting lives in the server's configuration.
- **The backup key is stored outside the Mac** (otherwise one lost Mac makes every backup unreadable).
- **A second admin and SSH key exist** (otherwise one unreachable person blocks restores and deploys). The Cockpit also reads the company's members: only one owner or admin is a warning until a second is added or this is confirmed. It cannot see instance admins or the server's keys.
- **The Mac that holds the keys is backed up.**

You cannot confirm them, and a question to the owner cannot carry them. Put each on the brief once with its steps and \`/<prefix>/setup\`: one line while it is open, then no more than a line a week in the retro.
`;

// ---------------------------------------------------------------------------
// Asking with an effect
// ---------------------------------------------------------------------------

export const ASKING_REFERENCE = `# Asking the owner so the answer does something

${T(TOOL_NAMES.askOwner)} asks once per issue. Every question carries a link to the exact screen where the owner acts (for a plain decision, the issue itself) and, for a grant, the steps. A question without them is refused with what is missing.

## With an effect

For a grant or a decision where a yes can be carried out for the owner, pass \`effect: { key, params }\`. When the owner says yes to your **first option** the plugin that handles the effect does it, reads it back to check it, and only then are you woken, with what happened. Put your recommendation first, and make the first option the thing the effect does.

- Keys exist only where a plugin handles them. Today: \`mailbox.delegate\` (let an agent read and draft in a shared mailbox), \`social.connect-account\` (connect a social account), \`cockpit.grant-memory-tools\` (let named agents use company memory). Use a key a skill or the Setup checklist names: a key no plugin handles gets no answer, and after 3 hours the ask fails and goes to the owner. Effects the Cockpit keeps for its own questions (adopting goals) are refused when you name them.
- The owner sees exactly what a yes will do, in the question itself. Params are plain text, numbers or true/false; the handler re-checks every one, so a wrong id is refused, never guessed.
- A no, or a reply with a condition ("yes, but only read"), applies nothing and wakes you with that. Do not ask again with the same card.

## When you are woken

The wake says what happened to the effect:

- **applied** (or already applied): carry on; the result was checked.
- **declined** or **unclear**: nothing changed. Work without it, or ask again with a clearer first option.
- **failed**, **refused**, **timeout**: it did not happen and a person has to look at why; the owner already has an item for it. Do not ask again.

Waiting on an answer: do what does not depend on it. Never poll, never comment to the owner, never assign the issue to a person.
`;


// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------

export const QUALITY_REFERENCE = `# Quality gates: proof, review, acceptance and skill checks

Four things keep "done" honest. The Cockpit raises a health check for each; this is what to do.

## Finished code with no proof

**"N finished code issues have no review and no proof"** lists issues the agents that write code closed in the last 7 days with no review (an approved review stage, or a linked issue assigned to a reviewer) and no comment that shows evidence. **Evidence** is a comment on the issue with at least one of: a commit or pull request link, test or build output (\`test\`, \`build\`, \`smoke\`, \`typecheck\` with a result), an HTTP check (curl and a status), a screenshot or attachment, a deploy status. A claim ("tests pass") is not evidence.

For each listed issue:
1. Open a review issue for a reviewer (the Reviewer, or the company's code reviewer when it has one), titled "Review: <identifier> <title>" (the identifier in the title is what links it). Say what to verify and "run it, do not trust the description". It counts as reviewed the moment it is linked. For an old issue that is plainly fine, ask the author for the evidence comment instead.
2. A change anyone sees needs a screenshot (\`pib-shot\`, the manual's \`references/screenshots.md\`): say so in the review issue.
3. Never reopen work just to move a number: the review decides.

Code issues should carry a review stage (\`executionPolicy\`: a \`review\` stage for the reviewer, \`commentRequired\` true). Whoever plans the work sets it when creating the issue; remind them with one comment when you see one without. Say it in the retro when the same agent keeps closing without proof.

## Outward approvals the Reviewer never saw

**"N outward approvals were never reviewed"**: an approval for work that leaves the company (cold email, a post, an invoice or quote email, a client report, an SEO pull request) is with a person, has no comment from the Reviewer, and the company has the Reviewer on. The "approvals with nobody to decide them" check is the other half (nobody assigned at all).

For each: assign it to the Reviewer and wake it (\`PATCH /api/issues/{id}\` with \`assigneeAgentId\` = the Reviewer's id from the brief's \`team\`, \`assigneeUserId\` null) and comment that it needs a late review before the owner decides. The Reviewer comments, then hands it back to the same person. If the Reviewer is paused or not staffed, it goes on the brief: the owner is about to decide unreviewed outward work and should know. Ledger, payroll and payment approvals are inward: no Reviewer unless asked. Never approve or cancel one yourself.

## Acceptance

When the owner has staffed an Acceptance agent, journeys run on the canary client every night and after each plugin release.
- **"N acceptance journeys are failing"**: each failed step has its own issue for the role that owns it, under the run's report. Wake each owner. When a journey fails because its file is out of date (a renamed tool or field), hand the change to journeys/<key>.json to whoever owns code. When the owner says it is fixed, ask for a re-run: open an issue for the Acceptance agent (\"Run journey <key> now\"); it starts the run with that issue and the report lands there. The Cockpit has no Run button.
- **"The nightly acceptance request is not being worked"**: the Acceptance agent is paused, in error or has no model key. Setup → Team, on the brief.
- A release whose journeys fail is not done. Say so on its issue and in the retro.

## Skill changes and their evals

A skill change can make agents worse and nobody sees it until a client does. Before one ships: ${T(EVAL_TOOL_NAMES.eval)} \`plan\` (mode candidate), make the harness runs it lists, \`record\`, \`gate\`. After it is deployed: \`plan\` (live), \`record\`, then \`baseline\`. A skill version that fails the gate does not ship; a regression after a deploy is reverted (the previous plugin version is one deploy away). The Skill Coach loop: \`${OPERATOR_REFERENCE_PATHS.coach}\`.

## Pages

Agents that build or test pages can screenshot one with \`pib-shot\`. A memory fact or guide that says agents cannot open a browser is out of date: supersede the fact (${T(MEMORY_TOOLS.update)} with \`status: "superseded"\`) and say in the retro which guide needs correcting.
`;

// ---------------------------------------------------------------------------
// The Skill Coach loop
// ---------------------------------------------------------------------------

export const COACH_REFERENCE = `# The Skill Coach loop

What agents learn should end up in their skills, measured. Paperclip ships a built-in **Reflection Coach** (an agent, a weekly routine and a skill): it reads another agent's recent issues and comments, groups the failures (a claim of done the reviewer rejected, rework, an existing rule not followed, late escalation, tool misuse) and proposes the smallest change as a diff, checked by replaying past successes. It never applies in the run that proposed: a person must accept a displayed diff first.

## What it cannot do here

Every PiB skill belongs to a plugin, and the plugin puts its own text back at each sync. A change to the company's copy lasts until the next sync, and nothing measures it. So: **the coach proposes; the change lands in plugin source through a pull request; the Cockpit measures it.**

## One-time setup (the owner, once: put it on the brief with these links)

1. Provision the coach: \`POST /api/companies/{companyId}/built-in-agents/reflection-coach/provision\` (needs \`agents:create\`: the owner, or the CEO agent). Pin its run profile like every agent (model claude-sonnet-5-5, timeout 3600 s, turn cap 200). It starts paused: resume it once its model key works.
2. Enable its weekly routine (board only): \`POST /api/companies/{companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/enable\`. Mondays 09:00 UTC. It stays off until a board user does this.
3. The skill policy: the Cockpit prints the exact PUT body (the \`cockpit.skill-policy-plan\` action); the owner applies it with \`PUT /api/companies/{companyId}/skill-policy\`. It denies every agent creating, editing, importing, installing, resetting or removing skills, except the Operator (who makes the test copies the evals use and the coach's own safe paths), and lets agents run skill tests.
Until all three are done the loop does not run: say so in the retro, once.

## Every Monday, after the coach has run

1. Read its reflection issues: each holds a proposal document with the clusters, the evidence and the diff.
2. For a proposal about a plugin-managed skill (its key starts \`plugin/\`): it needs at least two pieces of evidence (an issue and a quote), a diff and replay cases. Missing: comment what is missing and leave it.
3. Call ${T(EVAL_TOOL_NAMES.change)} with the diff, the reason, the evidence, the metric the change should move (\`metricKey\`: for example \`agent:<id>:failed_runs\` or \`company:reopen_rate\`) and the reflection issue as \`sourceIssueId\`. It applies the diff to the real text and refuses one that does not apply, goes over budget or carries a secret; records the change in the improvements ledger with today's baseline and a re-check date after the deploy; and returns the branch, the PR title and the PR body.
4. A diff that drops a "never" rule needs the owner: one ${T(TOOL_NAMES.askOwner)} (decision) with the proposal, and nothing merges before the answer.
5. Hand the package to the agent that owns code as a hand-off issue (the package is the issue body). The pull request goes into \`development\`, never \`main\`; the eval gate runs before it merges; a reviewer reviews it and whoever manages delivery merges it. Deploying is the owner's step (\`deploy-plugins.sh\`): put merged changes that wait for a deploy on the brief.
6. A proposal to change an agent's own instructions is the coach's own path: the owner accepts a displayed diff and the coach applies it in a later run. Put each pending acceptance on the brief with its link.

## After a change ships

- ${T(EVAL_TOOL_NAMES.eval)} \`plan\` (live), the harness runs, \`record\`, then \`baseline\`: the new text is the one to beat. Commit the entry to evals/results.json.
- The ledger entry is measured again on its date: improved, no change or worse. Worse: revert the pull request and deploy again. No change twice: drop it, and say why in the retro.
- At most three skill changes a week, and never two at once for one skill: you could not tell which one moved the number.

## Never

- Never apply a coach's proposal to the company's copy of a plugin skill.
- Never change a "never" rule, an approval step or a spending limit without the owner.
- Never count a proposal as an improvement until it is in the ledger with a number.
`;

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

/** The Operator skill's reference files, in the order the skill names them. */
export const OPERATOR_FILES: Array<{ path: string; content: string }> = [
  { path: OPERATOR_REFERENCE_PATHS.health, content: HEALTH_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.closeout, content: CLOSEOUT_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.retro, content: RETRO_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.goals, content: GOALS_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.credentials, content: CREDENTIALS_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.asking, content: ASKING_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.quality, content: QUALITY_REFERENCE },
  { path: OPERATOR_REFERENCE_PATHS.coach, content: COACH_REFERENCE },
];
