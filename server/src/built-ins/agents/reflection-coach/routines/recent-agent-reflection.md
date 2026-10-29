---
routineKey: recent-agent-reflection
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

Feature flag: this schedule ships **disabled** (`enabled: false`, routine `paused`). That is the flag. It stays off until tests have passed on `development` and an operator turns it on. Do not enable it from this run.

`PAPERCLIP_NIGHTLY_DREAMING` is the env override (`1`, `true`, or `on`). It defaults off. A scheduler follow-up must refuse to enqueue this routine unless that function returns true. Until that wire-up ships, the disabled schedule is what keeps the job from firing.

Prefer a cheap Grok model (`grok_local` or `hermes_local`). Do not change your own adapter in this run. If you are not already on a Grok adapter, say so in the changelog and continue.

## What this run must do

1. Read company heartbeat runs from the last `{{lookbackHours}}` hours, cap `{{maxRuns}}`. Use `GET /api/companies/$PAPERCLIP_COMPANY_ID/heartbeat-runs` and, for repeated failures only, `GET /api/heartbeat-runs/{runId}/log`. Skip your own runs.
2. Cluster repeated failures and the fix that followed. A cluster needs at least two runs, or one run plus a later issue comment that names the fix. No evidence, no proposal.
3. Draft at most `{{maxProposals}}` updates to a company skill or an agent's instructions (memory). Cap `{{maxTargetAgents}}` agents. Never draft a change to yourself.
4. Post one short changelog comment on this routine issue: window, runs read, clusters, drafts opened, what was not proposed.
5. For each draft, open a child issue assigned to the company agent whose `urlKey` is `code-reviewer`. Put the diff in the issue body. Title prefix: `Dream draft:`.

## Hard limits

- **Never apply.** Do not edit skills, `AGENTS.md`, agent memory, tool descriptions, or adapter config.
- **Never open `request_confirmation`.** Code Reviewer reviews the draft. Application, if any, is a later issue that is not this routine.
- Do not enable this schedule, do not flip `PAPERCLIP_NIGHTLY_DREAMING`, and do not reset built-in stock.
- Keep every read company-scoped.
- Size caps still hold: skills ≤ 15KB, tool descriptions ≤ 500 chars, `AGENTS.md` growth ≤ +20% per draft.

## Output

A changelog comment on this issue, plus zero or more `Dream draft:` child issues assigned to Code Reviewer. No mutations.
