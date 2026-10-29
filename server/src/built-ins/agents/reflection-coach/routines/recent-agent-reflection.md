---
routineKey: nightly-dreaming
title: Nightly dreaming — draft skill and memory proposals from run logs
description: Read the day's run transcripts, cluster repeated failures and the fixes that followed, and draft company skill or agent-memory proposals. Drafts go to Code Reviewer. This routine never applies a change.
assigneeRef:
  resourceKind: agent
  resourceKey: reflection-coach
status: paused
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: lookbackHours
    label: Lookback window (hours)
    type: number
    defaultValue: 24
    required: true
    options: []
  - name: maxRuns
    label: Max runs to read
    type: number
    defaultValue: 40
    required: true
    options: []
  - name: maxProposals
    label: Max draft proposals
    type: number
    defaultValue: 5
    required: true
    options: []
  - name: maxTargetAgents
    label: Max target agents
    type: number
    defaultValue: 8
    required: true
    options: []
triggers:
  - kind: schedule
    label: Nightly dreaming draft
    enabled: false
    cronExpression: "15 3 * * *"
    timezone: Africa/Johannesburg
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Nightly dreaming (draft only)

Feature flag: this schedule ships **disabled** (`enabled: false`, routine `paused`) on routine key `nightly-dreaming`. It is a new key so startup reconcile does not rewrite the older `recent-agent-reflection` row.

`PAPERCLIP_NIGHTLY_DREAMING` (`1`, `true`, or `on`) is the server gate. It defaults off. The enable route and the run route refuse this key unless that function returns true. Reconcile also forces this trigger off when the flag is off, even if a previous enable left it on.

Prefer a cheap Grok model (`grok_local` or `hermes_local`). Those adapters are on the allowlist so an operator can pin this coach to Grok. Do not change your own adapter in this run. If you are not already on a Grok adapter, say so in the changelog and continue.

## What this run must do

1. Read company heartbeat runs from the last `{{lookbackHours}}` hours (1–168), cap `{{maxRuns}}` (1–200). Use `GET /api/companies/$PAPERCLIP_COMPANY_ID/heartbeat-runs` and, for repeated failures only, `GET /api/heartbeat-runs/{runId}/log`. Skip your own runs. Refuse the run if a variable is outside its bound. Those numeric bounds are prompt-only. The server does not reject an out-of-range value.
2. Cluster repeated failures and the fix that followed. A cluster needs at least two runs, or one run plus a later issue comment that names the fix. No evidence, no proposal.
3. Draft at most `{{maxProposals}}` updates (1–20) to a company skill or an agent's instructions (memory). Cap `{{maxTargetAgents}}` agents (1–30). Never draft a change to yourself.
4. Before a new skill draft, classify company skills with the rules in `server/src/services/skill-hygiene.ts`. A skill is agent-owned only when `managedBy` is `agent` and it is not catalog, plugin, github, url, skills.sh, or a `paperclipai/` key. Everything else is protected, including a missing marker. Never draft a create, edit, merge, or archive for a protected skill. That includes skills a human wrote or installed.
5. Near-duplicate means two agent-owned skills whose name and description share at least 3 tokens and a Jaccard overlap of at least 0.5. Draft one merge. Keep the higher use count. Say which skill absorbs which. Do not open a second skill for that scenario. A correction updates the existing agent-owned skill. It does not add a near-duplicate.
6. Archive only an agent-owned skill that is at least 14 days old and has use count 0 and view count 0. Unknown usage is not unused. An archive draft moves the skill aside. It does not delete it. Do not archive the skill a merge keeps.
7. Post one short changelog comment on this routine issue: window, runs read, clusters, drafts opened, skill count before, protected count, agent-owned count, merge drafts, archive drafts, skill count after, and what was not proposed. Skill count after equals skill count before. This routine never applies.
8. For each draft, open a child issue assigned to the company agent whose `urlKey` is `code-reviewer`. Put the diff in the issue body. Title prefix: `Dream draft:`. A new agent skill draft must include `managedBy: agent`. Without that marker a later run treats it as protected.

## Hard limits

- **Never apply.** Instruction routes return 403 without `agents:suggest-changes`. Skill routes return 403 because reconcile writes a coach-only skill-policy deny (`reflection-coach-never-apply`) that wins over an owner allow. Revoking `skills:suggest-changes` alone does not stop skill writes. Do not edit skills, `AGENTS.md`, agent memory, tool descriptions, or adapter config. The "never apply" line in this prompt is not the stop. The routes are.
- **Never open `request_confirmation`.** Code Reviewer reviews the draft. Application, if any, is a later issue that is not this routine.
- Redact tokens, API keys, `Authorization` headers, and env values before you copy a log line into a draft or a comment. Replace them with `[redacted]`.
- Do not enable this schedule, do not flip `PAPERCLIP_NIGHTLY_DREAMING`, and do not reset built-in stock.
- Keep every read company-scoped.
- Size caps still hold: skills ≤ 15KB, tool descriptions ≤ 500 chars, `AGENTS.md` growth ≤ +20% per draft.
- Do not inject a learned-skill index into other agents' sessions. If you list agent-owned skills, put that list only in this changelog.
- Do not add a /learn command. A manual run of this routine is the on-demand path, and the flag still gates it.

## Output

A changelog comment on this issue, plus zero or more `Dream draft:` child issues assigned to Code Reviewer. No mutations.
