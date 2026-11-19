# Workspaces, Cases, Skills, Routines and Niche Workflows

Moved verbatim from `SKILL.md` (PAR-13541). Load on demand.

## Niche Workflow Pointers

Load `references/workflows.md` when the task matches one of these:

- Set up a new project + workspace (CEO/Manager).
- Generate an OpenClaw invite prompt (CEO).
- Set or clear an agent's `instructions-path`.
- CEO-safe company imports/exports (preview/apply).
- App-level self-test playbook.

## Cases

Load `references/cases.md` when creating, upserting, documenting, attaching to,
or linking cases through the agent-facing cases API.

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `POST /api/agents/{agentId}/skills/sync` and an explicit `add`, `remove`, or `replace` mode. Prefer `add`; `replace` overwrites the complete desired skill set.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## Routines

Routines are recurring tasks. Each time a routine fires it creates an execution issue assigned to the routine's agent — the agent picks it up in the normal heartbeat flow.

- Create and manage routines with the routines API — agents can only manage routines assigned to themselves.
- Add triggers per routine: `schedule` (cron), `webhook`, or `api` (manual).
- Control concurrency and catch-up behaviour with `concurrencyPolicy` and `catchUpPolicy`.

If you are asked to create or manage routines you MUST read:
`skills/paperclip/references/routines.md`

## Task Files and Workspace Choices

Use the task's provided working directory for task files. `AGENT_HOME` holds personal instructions and memory; provider home is runtime-managed. A task does not need a project or Git repository. Do not clone unrelated repositories or place task output in home to compensate for a missing project.

Use `get_workspace` to inspect the current folder, pending selection, and capabilities. Use `list_workspaces` for authorized existing folders and `list_project_repositories` for repository choices. `select_workspace` and `prepare_repository` express intent; the harness validates and prepares it. Respect `next_normal_admission` responses: keep the current root, do not claim the requested checkout exists, and do not retry in a loop or interrupt the run. Project assignment alone does not relocate files. See `references/issue-workspaces.md` for the API equivalents.

Prefer a matching configured, authorized source over guessing a repository URL. Inspect available runtime and testing capabilities before claiming that browser or command testing is unavailable. When an authorized repository is pending and unfinished work needs it, finish independent work, explain the remaining work, and yield. Native Runner can select the saved same-agent continuation from current task context; it does not need a timer or a user restart. A request only to stage a repository can finish normally without starting more work.

## Issue Workspace Runtime Controls

When an issue needs browser/manual QA or a preview server, inspect its current execution workspace and use Paperclip's workspace runtime controls instead of starting unmanaged background servers yourself.

For commands, response fields, and MCP tools, read:
`skills/paperclip/references/issue-workspaces.md`

