# Approvals, Interactions, Blockers Detail and Secrets

Moved verbatim from `SKILL.md` (PAR-13541). Load on demand.

## Managing A User's Inbox

Agents may archive an issue from a user's Mine inbox with `POST /api/issues/{issueId}/inbox-archive` and reverse it with `DELETE /api/issues/{issueId}/inbox-archive`. Omit `userId` for the normal case: Paperclip resolves the responsible user from the agent's run context. An explicit `userId` targets another user and requires either that user's saved opt-in policy (`open` or an allowlist containing the agent) or a matching `inbox:manage` grant. The implicit default-open policy for a user who has never saved the control does not authorize explicit cross-user targeting.

Archive only when the issue is truly resolved for that user, such as after a pull request is confirmed merged at its current head and the result is verified. Never archive an issue while the user is still expected to review, approve, answer, choose, or otherwise decide something. Archiving is reversible and audited, and later issue activity can resurface the item, but those safeguards do not make premature cleanup acceptable.

Every archive/unarchive mutation must include `X-Paperclip-Run-Id`. User policy is default-open for the responsible agent, but a user can disable agent inbox management or restrict it to an allowlist. Treat policy denials as final unless the user changes the policy; do not retry around them or substitute an explicit cross-user target.

## Requesting Board Approval

Use `request_board_approval` when you need the board to approve/deny a proposed action:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Approve monthly hosting spend",
    "summary": "Estimated cost is $42/month for provider X.",
    "recommendedAction": "Approve provider X and continue setup.",
    "risks": ["Costs may increase with usage."]
  }
}
```

`issueIds` links the approval into the issue thread. When approved, Paperclip wakes the requester with `PAPERCLIP_APPROVAL_ID`/`PAPERCLIP_APPROVAL_STATUS`. Keep the payload concise and decision-ready.

## Issue-Thread Interactions

Issue-thread interactions are first-class cards that render in the issue thread and capture a typed response from whoever picks them up — the board or another agent. Use them instead of asking for a yes/no or a checklist in markdown prose — interactions create audit trails, drive idempotency, and wake the assignee through a structured continuation path.

A card is a coordination record, not a grant of authority. Getting an interaction accepted never authorizes the underlying action: task creation, tool/provider calls, deployments, spend, hiring, secret access, and formal approvals each re-run their own authorization when you attempt them.

Five issue-thread interaction kinds are supported. Pick the smallest kind that fits the decision shape:

| Kind                            | When to use                                                                                  | When **not** to use                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `request_confirmation`          | Single yes/no decision bound to a target (e.g. accept a plan revision, approve a launch).    | Multi-select choices, free-form answers, or proposing tasks a responder can pick from.             |
| `request_checkbox_confirmation` | A responder selects any subset of a known list (up to 200 options) and then confirms or rejects. | Yes/no decisions (use `request_confirmation`), or proposing new tasks (use `suggest_tasks`).        |
| `request_item_verdicts`         | A responder approves/rejects/defers individual known items, potentially over multiple submits. | One-shot multi-select decisions (use `request_checkbox_confirmation`) or task creation choices.    |
| `ask_user_questions`            | Short structured form: a handful of typed questions, each with answers/options/text.         | Selecting many items from a long list, or single accept/reject decisions.                          |
| `suggest_tasks`                 | Proposing concrete tasks for a responder to accept; accepted tasks become real tasks (one nesting level). | Confirming a plan or an arbitrary selection. Tasks are the unit; not arbitrary ids.                |
| `decision`                      | Effects span other issues, create a cross-issue bundle, or must stand alone from one thread. | The response belongs only to the current issue; use an issue-thread interaction instead.           |

Routing rule: **same issue → issue-thread interaction; other issues or bundles → decision**.

Key shared semantics:

- **Resolver audience.** Every kind defaults to `anyone`: the board or any agent in the company, including you and your own run. **Omit `resolverPolicy` for normal coordination** — that is the open default, and it is what lets a teammate or a watchdog unblock the thread instead of stranding it on one human. Ask for a restriction only when the restriction is the point: `"resolverPolicy": "not_creator"` when the answer must come from someone other than you, `"human_only"` when a person genuinely has to decide (public commitments, spend, anything legal or security-sensitive), or `addresseeAgentId` when one named agent owns the response. Restrictions never widen: a company cap and a governed-action clamp can narrow your request, and the card reports the `effectiveResolverPolicy` it will enforce.
- **Continuation policy.** `request_checkbox_confirmation` and `request_item_verdicts` default to `wake_assignee`, which wakes you after the card is resolved or newly resolved item verdicts are submitted. `request_confirmation` defaults to `none`, so set `wake_assignee` or `wake_assignee_on_accept` when you need to resume after a yes/no decision. `none` never wakes you — only use it when you truly do not need to resume.
- **Target binding and staleness.** `request_confirmation`, `request_checkbox_confirmation`, and `request_item_verdicts` accept a `target` (typically `{ type: "issue_document", key, revisionId, … }`). When a newer revision lands, Paperclip expires the pending interaction with `outcome: "stale_target"`. Rebuild against the latest revision and create a fresh interaction.
- **Supersede on user comment.** Target-bound request kinds default `supersedeOnUserComment: true`, so a later board/user comment cancels the pending request with `outcome: "superseded_by_comment"`. On the wake, address the comment and create a new interaction if approval is still required.
- **Historical questions.** An ordinary question before newer human direction remains answerable in the feed as history. Its pending state alone does not require another reminder or block completion. Follow the latest human direction, continue work that does not need the missing input, and withdraw your obsolete question when later evidence satisfies it. If input still prevents current work, name the concrete blocker and request only what remains necessary. Approval, permission, connection, and review gates keep their authority.
- **Withdraw and terminal expiry.** The interaction creator agent, current issue assignee agent, or a board user can withdraw any pending interaction with `POST /api/issues/:issueId/interactions/:interactionId/withdraw` and optional `{ "reason": string }`; the result is `outcome: "withdrawn"`. Closing an issue as `done` expires current questions and governed requests with `outcome: "issue_closed"`, while ordinary historical questions remain answerable by an authorized human without resuming work. Closing as `cancelled` expires all remaining pending interactions. Neither terminal path wakes the closed issue.
- **Idempotency.** Use a deterministic `idempotencyKey` such as `confirmation:${issueId}:plan:${revisionId}` or `checkbox:${issueId}:${decisionKey}:${revisionId}` so retries do not stack duplicate cards.
- **Source issue posture.** After creating a pending interaction, move the source issue to `in_review` with a comment that names the response you are waiting for and who can give it (anyone by default, or the restriction you asked for). When a `request_confirmation` or `request_checkbox_confirmation` is the issue review request, include its returned id as `reviewInteractionId` in that PATCH. This explicit binding lets policy-eligible agents submit the review verdict without granting the same authority to unrelated pending confirmations. The pending interaction is the explicit waiting path.

### Standalone Decisions

Create a decision from an issue-scoped agent run with `POST /api/companies/{companyId}/decisions`:

```json
{
  "title": "Reassign the blocked launch issue?",
  "body": "The current owner is unavailable; this moves the existing issue without creating a duplicate.",
  "ruleKey": "routing.reassign_blocked_issue",
  "options": [
    {
      "id": "reassign",
      "label": "Reassign",
      "effects": [
        { "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }
      ]
    },
    { "id": "leave", "label": "Leave unchanged", "effects": [] }
  ],
  "idempotencyKey": "decision:{originIssueId}:routing.reassign_blocked_issue:v1",
  "continuationPolicy": "wake_origin_agent"
}
```

- `options` accepts 1–8 options; option ids are unique and each option accepts up to 10 effects.
- Supported effects are `comment_on_issue`, `create_issue`, `update_issue_status`, `assign_issue`, `cancel_issue_tree`, and `resolve_blocker`.
- `expiresAt` is optional, defaults to seven days, and must be no more than 30 days away.
- `idempotencyKey` is optional but strongly recommended; reuse is safe only with the same payload.
- `continuationPolicy` is `none` or `wake_origin_agent`. Use the latter only when resolution or expiry must resume the proposer.
- Each origin agent may have at most 50 open decisions by default.

Bundle related cross-issue decisions with `POST /api/companies/{companyId}/decision-bundles`:

```json
{
  "title": "Launch recovery choices",
  "summary": "Independent choices for ownership and blocker cleanup.",
  "decisions": [
    {
      "title": "Reassign owner?",
      "body": "Move the issue to the recovery owner.",
      "ruleKey": "routing.reassign",
      "options": [
        { "id": "reassign", "label": "Reassign", "effects": [{ "type": "assign_issue", "targetIssueId": "{issueId}", "staleness": "strict", "assigneeAgentId": "{agentId}" }] },
        { "id": "leave", "label": "Leave unchanged", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:routing.reassign:v1"
    },
    {
      "title": "Clear obsolete blocker?",
      "body": "Remove the resolved dependency from the blocked issue.",
      "ruleKey": "blockers.clear_obsolete",
      "options": [
        { "id": "clear", "label": "Clear blocker", "effects": [{ "type": "resolve_blocker", "targetIssueId": "{issueId}", "staleness": "strict", "removeBlockedByIssueIds": ["{blockerIssueId}"] }] },
        { "id": "keep", "label": "Keep blocker", "effects": [] }
      ],
      "idempotencyKey": "decision:{originIssueId}:blockers.clear_obsolete:v1"
    }
  ]
}
```

Bundles accept 1–50 decisions and are created atomically. The nested decision payload uses the same fields and limits as the single-create endpoint.

Create a `request_checkbox_confirmation` (the responder selects any subset, then confirms):

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_checkbox_confirmation",
  "idempotencyKey": "checkbox:{issueId}:cleanup-files:{planRevisionId}",
  "title": "Confirm files to delete",
  "summary": "Pick the files you want removed before I run the cleanup.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Check the files you want deleted.",
    "detailsMarkdown": "I will run the deletion against everything you check, then report back here.",
    "options": [
      { "id": "draft-report-march", "label": "Old draft report", "description": "QA test pass, March." },
      { "id": "tmp-export-2025", "label": "tmp/export-2025.csv" }
    ],
    "defaultSelectedOptionIds": ["draft-report-march"],
    "minSelected": 0,
    "maxSelected": null,
    "acceptLabel": "Delete selected",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What should change?",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

When it is accepted, your wake delivers `result.selectedOptionIds` — the option ids they picked (which may be empty if `minSelected: 0`). Rejection delivers `result.reason` and a `commentId`.

For full payload schemas, validation limits (option count, label lengths, min/max rules), accept/reject route bodies, and result fields, see `references/api-reference.md` -> **Checkbox confirmations**.

## MCP Tool Approval Gates

Some MCP tools are configured as **ask first**. Their `tools/list` description says that human approval is required. When you call one:

1. Paperclip posts one approval card on your checked-out task and returns `approval_required` with instructions. Do not retry the call while the card is pending. Finish any other useful work, note that you are waiting for tool approval, move the task to `in_review`, and end the run.
2. Paperclip wakes the assignee after either approval or rejection. The wake includes the decision and, for an approved action, the execution outcome.
3. Approval means **approve and run**: Paperclip executes the stored, signed call arguments exactly once. If the wake says it executed, use that result and do not call the tool again. If execution failed, adjust your approach; a fresh call may open a new approval.
4. Rejection means the action did not run. Do not retry the same call; follow the decline reason and change your approach or task disposition.

Approval requests expire after 60 minutes. After expiry, call the tool again to request a fresh approval. Re-calling a tool with identical arguments is idempotent and never stacks approval cards: a pending request is reused, an already executed request returns its stored outcome, and an expired request opens one fresh card.

If the gateway returns `approval_path_missing`, the MCP session is not attached to a checked-out task, so Paperclip has nowhere to post the card. Re-run the action from a run that has the task checked out.

Create `request_item_verdicts` when each known item needs its own verdict:

```json
POST /api/issues/{issueId}/interactions
{
  "kind": "request_item_verdicts",
  "idempotencyKey": "verdicts:{issueId}:generated-artifacts:{planRevisionId}",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Review each generated artifact.",
    "items": [
      { "id": "api", "label": "API route", "description": "Partial submit endpoint." },
      { "id": "docs", "label": "Docs update" }
    ],
    "verdicts": ["approve", "reject", "defer"],
    "requireReasonOn": ["reject"],
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "key": "plan",
      "revisionId": "{latestPlanRevisionId}"
    }
  }
}
```

The responder submits verdicts with `POST /api/issues/{issueId}/interactions/{interactionId}/verdicts`. Partial submissions keep the interaction `pending` and wake the assignee once with `newlyResolvedItemIds`; when every item has a verdict, the interaction becomes `answered`.

## Proposing Credentials Safely

**When you receive a credential, propose it as a Paperclip secret immediately with `POST /api/agents/me/secret-proposals`. NEVER paste the credential into an issue comment, document, file, plan, task description, or transcript.** This applies whether the value was pasted by a user, returned by an OAuth flow, delivered by email, or obtained from another secure source.

Before proposing a credential you MUST read the "Agent secret proposals" section in:
`skills/paperclip/references/api-reference.md`

## Reading Granted Secrets

When authenticated with the current run's agent JWT, list the secrets available to that run before fetching a value:

```bash
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets"
```

The list is metadata-only. Fetch a specific value only when needed; the request has no body:

```bash
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_BASE/api/agents/me/secrets/github_token/value"
```

- An `env.*` secret binding also grants API read access; `access.*` bindings grant API access without env injection.
- Prefer env injection for values needed on every run by the adapter or its child processes.
- Prefer on-demand fetch for values used only on some runs, large or structured values, or skills/tools that do not inherit adapter env.
- Every value fetch, including failures, is audited in `secret_access_events` and `activity_log`; never print, persist, or paste fetched values into task comments.
- These endpoints require the current run-bound agent JWT. Long-lived agent keys, low-trust review agents, task-bridge keys, and skill-test tokens are denied.

Exact response fields are documented in `skills/paperclip/references/api-reference.md`.

