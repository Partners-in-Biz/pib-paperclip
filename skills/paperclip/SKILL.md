---
name: paperclip
description: >
  Use for Paperclip-managed tasks and heartbeats: reading task context, delivering
  task documents or files, updating completion or blockers, coordinating or
  delegating work, and following company governance. Includes control plane API
  operations for assignments, comments, approvals, and routines.
---

# Paperclip Skill

You run in **heartbeats**: short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## Terminology

In Paperclip, **task** and **issue** refer to the same work item. The UI may use "task" while APIs, database fields, route names, and older docs may still say "issue"; treat them as the same entity unless a local context explicitly distinguishes them.

**Task documents (API runtimes).** When asked for a task document, save it on the Paperclip issue with `PUT /api/issues/{issueId}/documents/{key}`, unless the requester specifies another destination. Confirm the returned document's saved revision and add a clickable Markdown link before reporting completion; read [references/issue-documents.md](references/issue-documents.md) for the payload and revision-safe updates. Downloadable files follow [Generated Artifacts and Work Products](#generated-artifacts-and-work-products).

## Reference Index

Heartbeat steps (checkout, work, comment, status), artifacts, monitors and critical rules are NOT in this core file: open the matching reference before acting.

| When you need | Read |
|---|---|
| Heartbeat procedure, auth detail, critical rules, comment style, planning, hot routes, artifacts, monitors, review delegation | [references/heartbeat-procedure.md](references/heartbeat-procedure.md) |
| Board approvals, issue-thread interactions, standalone decisions, MCP tool gates, credentials, granted secrets, user inbox | [references/interactions-and-approvals.md](references/interactions-and-approvals.md) |
| Workspaces, task files, cases, company skills, routines, niche workflows | [references/workspaces-and-niche-workflows.md](references/workspaces-and-niche-workflows.md) |
| Full API tables, schemas, worked examples, error codes | [references/api-reference.md](references/api-reference.md) |
| Task documents and revisions | [references/issue-documents.md](references/issue-documents.md) |
| Artifacts and work products | [references/artifacts.md](references/artifacts.md) |
| Issue workspaces | [references/issue-workspaces.md](references/issue-workspaces.md) |
| Routines / cases / company skills / workflows / run diagnostics | [routines](references/routines.md), [cases](references/cases.md), [company-skills](references/company-skills.md), [workflows](references/workflows.md), [run-diagnostics](references/run-diagnostics.md) |

## Authentication

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY` (short-lived run JWT for local adapters). Optional wake context: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, `PAPERCLIP_LINKED_ISSUE_IDS`. Send `Authorization: Bearer $PAPERCLIP_API_KEY` on every request; endpoints are under `/api`. Never hard-code the API URL or paste the key into prompts, comments, documents or logs. Add `-H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID'` on every request that modifies issues. Read the wake payload in the run prompt first; fetch the thread only when `fallbackFetchNeeded` is true. For CLI calls with content-bearing arguments use `npx paperclipai`, never `pnpm paperclipai`. Full text: [heartbeat-procedure.md](references/heartbeat-procedure.md).

## Comments (Required)

Use concise markdown: a short status line, bullets for what changed or is blocked, links to related entities. Ticket ids are links with the company prefix (`[PAP-224](/PAP/issues/PAP-224)`); no bare ids, no raw UUIDs in prose; describe outcomes, not control-plane mechanics; build multiline JSON with `jq -n --arg` or a heredoc. All internal links carry the company prefix. Full rules and URL shapes: [heartbeat-procedure.md](references/heartbeat-procedure.md#comment-style-required).

## Status Quick Guide

- `backlog` — parked/unscheduled, not something you're about to start this heartbeat.
- `todo` — ready and actionable, but not checked out yet. Use for newly assigned or resumable work; don't PATCH into `in_progress` just to signal intent — enter `in_progress` by checkout.
- `in_progress` — actively owned, execution-backed work.
- `in_review` — paused pending reviewer/approver/board/user feedback. Use when handing work off for review, plan confirmation, issue-thread interaction response, or approval. This is a healthy waiting path, not a synonym for done. If a human asks to take the task back, reassign to them and set `in_review`.
- `blocked` — cannot proceed until something specific changes. Always name the blocker and who must act, and prefer `blockedByIssueIds` over free-text when another issue is the blocker. `parentId` alone does not imply a blocker.
- `done` — work complete, no follow-up on this issue.
- `cancelled` — intentionally abandoned, not to be resumed.

## Issue Dependencies (Blockers)

Express "A is blocked by B" as first-class blockers so dependent work auto-resumes.

**Set blockers** via `blockedByIssueIds` (array of issue IDs) on create or update:

```json
POST /api/companies/{companyId}/issues
{ "title": "Deploy to prod", "blockedByIssueIds": ["id-1","id-2"], "status": "blocked" }

PATCH /api/issues/{issueId}
{ "blockedByIssueIds": ["id-1","id-2"] }
```

The array **replaces** the current set on each update — send `[]` to clear. Issues cannot block themselves; circular chains are rejected.

**Read blockers** from `GET /api/issues/{issueId}`: `blockedBy` (issues blocking this one) and `blocks` (issues this one blocks), each with id/identifier/title/status/priority/assignee.

**Automatic wakes:**

- `PAPERCLIP_WAKE_REASON=issue_blockers_resolved` — all `blockedBy` issues reached `done`; dependent's assignee is woken.
- `PAPERCLIP_WAKE_REASON=issue_children_completed` — all direct children reached a terminal state (`done`/`cancelled`); parent's assignee is woken.

`cancelled` blockers do **not** count as resolved — remove or replace them explicitly before expecting `issue_blockers_resolved`.

## Task Documents and Deliverables

Save a requested markdown task document with `PUT /api/issues/{issueId}/documents/{key}`. Use PUT for both creation and updates; POST is not supported here. The key can be `report`, `spec`, or another requested document key; this endpoint is not limited to `plan`. Include the usual bearer authorization and `X-Paperclip-Run-Id` headers.

For a new report, use:

```json
{"title":"Report","format":"markdown","body":"The completed report text","baseRevisionId":null}
```

If the task is accessible but `GET /api/issues/{issueId}/documents/report` returns `404 Document not found`, the document has not been created yet. Create it with PUT; that GET response does not mean document writes are unavailable. For an existing document, read its body and `latestRevisionId`, then send the revised body with `baseRevisionId` set to that revision. On `409`, fetch and reconcile the latest document before retrying.

Read the saved document back before marking the task done. A comment or local file does not satisfy a request for a task document. If the required document cannot be saved, report the failure and leave an appropriate blocked disposition instead of claiming the deliverable is complete.
