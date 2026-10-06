# PiB Platform: agent guide

This fork of Paperclip carries the Partners in Biz plugins: CRM, Social, Billing, Mailbox, SEO, Partners, Campaigns, Accounting, Payroll, Cockpit, Setup and Ads (not installed yet), the shared `pib-plugin-kit` and `pib-plugin-ui`, and the WordPress connector. They run inside our own Paperclip (one company; clients are CRM companies). Plugin install is instance-wide, plugin settings are per company.

Every rule below was checked on 2026-10-06. If the code disagrees, trust the code and fix this file in your PR. The root `AGENTS.md` is Paperclip's own contributor guide for the whole product. Where it conflicts with this file, this file wins for work in this project.

## What you may change

- Only `packages/plugins/`. The one other file we own is `.github/workflows/pib-plugins-ci.yml`, plus the root `CLAUDE.md` that points at this guide.
- Never edit `server/`, `ui/`, `cli/`, `packages/db`, `packages/shared`, `packages/adapters` or the upstream plugin packages (`sdk`, `examples`, `sandbox-providers`, `plugin-llm-wiki` and the like). The fork merges upstream, so edits there conflict and are lost. Read them to match the host.
- If the bug is in the host, do not patch it. Write the finding on the issue (file, line, how to reproduce, what you expected) and mark it for Peet. Host patches and upstream reports are his call.

## Branches and workspace

- `development` is the working branch. `master` only moves with the upstream merge: never push to it and never merge upstream yourself.
- Work on a branch cut from `origin/development` (`fix/par-123-short-name`, `feat/...`) and open a PR into `development`. Never force-push `development`.
- The project uses one shared checkout and runs one task at a time. First step of every task: `git fetch origin && git switch development && git pull --ff-only`, then cut your branch. Last step: push, `git switch development`, leave the tree clean. Never reset or discard another run's changes: stash them with a message.
- Merging to `development` does not put anything live. Only a deploy does (see below).

## Setup and checks

- First, once per fresh checkout and after a lockfile change: `bash packages/plugins/agent-setup.sh`. It puts Node 24 first (`/opt/node24/bin`; the default `node` is 20), installs with `--frozen-lockfile --ignore-scripts`, builds the plugin SDK and links the embedded Postgres libraries. Without that last step every `*.pg.spec.ts` test fails with "Postgres init script exited with code 127". That is the setup, not your change.
- pnpm comes through corepack (`corepack pnpm ...`, version pinned in the root `package.json`). Run it from inside the checkout.
- Before you call work done, in each package you changed: `cd packages/plugins/<pkg> && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build`. A change to `pib-plugin-kit` or `pib-plugin-ui` needs the same in every plugin that uses it. The kit's `test` also runs the contract tests that check skill text against the registered tools of every plugin.
- CI (`PiB plugins CI`) runs the same three steps for every package on each PR. A red check blocks the merge.
- Commit per plugin with `fix(<plugin>):`, `feat(<plugin>):`, `chore(<plugin>):` or `docs:` prefixes.

## What a release needs

- Bump the plugin's version in its `package.json` and everywhere its manifest takes it from: a `version:` literal in `src/manifest.ts` or a `VERSION` constant it imports (it differs per plugin, so run `grep -rn "<old version>" packages/plugins/<pkg>/src`). The deploy refuses a build whose manifest version differs from `package.json`, or a version that is already live.
- Migrations are additive. Add the next numbered file in `<plugin>/migrations/`. Never edit or delete one that has been applied: a rolled-back deploy keeps its migrations, so the old code must run on the newer schema.
- A new migration file, or a changed `capabilities` or `coreReadTables` list, makes the release stop-first: it waits for a quiet moment, stops Paperclip and restarts it. Say so in the PR title or description. Anything else ships src-only with no restart.
- A plugin's skill text reaches every company's agents on the next deploy. Say in the PR when a change alters what agents do for clients.
- Renaming or removing the read-only tool that a plugin's smoke test calls fails the deploy's smoke test on purpose. The smoke table lives in the ops repo, which you cannot edit. Name it in the PR so it is changed with the release.
- If a plugin writes files into its own `dist/` while it runs (the CRM does under `dist/ui/s/`), the deploy script must exclude that folder. Tell the Delivery Lead before you add another.

## Deploying

- You do not deploy. After the merge, the Delivery Lead asks the deploy runner: `pib-deploy-request deploy <plugin> --issue PAR-n --sha <merge commit on development>`. A src-only release goes live within minutes. A stop-first release waits for the night window and for no agent run in flight, and never forces a restart. The result comes back as a comment on the issue.
- The runner can refuse (a hold on that plugin, the daily cap, a failed earlier deploy). Read the reason in `pib-deploy-request status <id>` and comment it on the issue. Do not try another route: no ssh, no root, no deploy scripts.
- Installing a plugin that is not on the server yet (`plugin-ads` is the first) is Peet's, not a normal release.

## Stop and ask Peet (put it on the issue, one batched question)

- Anything in `server/`, `ui/` or `cli/`, host patches, Paperclip upgrades, or the VPS as root.
- Opening, commenting on or filing anything upstream (`paperclipai/paperclip`).
- GitHub org, ruleset, branch protection, token or secret changes.
- Client repos and client sites. This project is the platform only. A client task goes in the client's own project.

## Secrets

- Never print, log, quote or commit token or environment values, in an issue, a comment or a PR. Name where a credential lives, never its value.
- Use the GitHub credential only for pushing and PRs on this repo.

## Where the truth lives

- Plugin capabilities: `PLUGIN_CAPABILITIES` in `packages/shared/src/constants.ts` (read only). The manifest type is in `packages/shared/src/types/plugin.ts`, and the worker context in `packages/plugins/sdk/src/types.ts`.
- How to build a plugin: `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`. Lifecycle and isolation rules: `doc/plugins/PLUGIN_SPEC.md` (its capability list is behind the constant).
- The short release runbook: `packages/plugins/DEPLOY.md`. It names the Mac deploy script; agents use the request tool above instead.
