# Deploying the PiB plugins

One rule: **commit, push to `origin/development`, then deploy.** The deploy script refuses a dirty or unpushed tree, so what runs on the VPS is always a commit you can find.

The script is not in this repo (ops tooling is not product code, see the fork rule). It lives in the PiB Paperclip repo:

```
~/Cowork/pib-paperclip/"PiB Paperclip"/operations/vps/deploy-plugins.sh
```

Full runbook, the checks it makes and how to read a failure: `operations/vps/docs/release.md` in that repo.

## Once, before the first deploy

Run the smoke test yourself with its tool calls on, so a wrong entry shows up now and not inside a deploy:

```
ssh root@65.108.146.144 'bash -s' < ~/Cowork/pib-paperclip/"PiB Paperclip"/operations/vps/smoke-plugins.sh
```

(The deploy also runs it once *before* it changes anything, as a baseline: a check that already fails then is reported and never blamed on the deploy. Only a check that passed before and fails after rolls a deploy back.)

## Normal deploy

1. Work on `development`. Bump the plugin's version in `package.json` and in the constant its manifest reads (the host registers the manifest's version; the pre-flight refuses a build whose manifest version differs from `package.json`).
2. Commit per plugin and push: `git push origin development`. CI (`.github/workflows/pib-plugins-ci.yml`) runs typecheck, tests and build for every PiB package.
3. Look before you ship:

   ```
   deploy-plugins.sh --dry-run seo crm
   ```

   It runs the same pre-flight as a real deploy (clean tree, pushed, typecheck, tests, build, version bumped, no applied migration changed) and prints the plan, then stops before the VPS is touched.
4. Ship it:

   ```
   deploy-plugins.sh seo crm          # plugin names: seo crm billing cockpit social campaigns mailbox accounting payroll partners setup ads
   deploy-plugins.sh connector        # the WordPress connector is built into the CRM: this deploys crm and checks the zip
   deploy-plugins.sh all              # every plugin that is INSTALLED on the VPS; one that is not (ads, until its first install) is skipped with a note
   ```

## What it decides for you

- **Stop-first** when a plugin has a new migration file or a changed capability or `coreReadTables` list: it waits until no agent run is in flight (up to 45 min), takes a database dump, stops Paperclip, copies, starts, checks.
- **Src-only** for everything else: it copies into the running server and calls `POST /api/plugins/<key>/upgrade`. No restart, no interrupted runs.
- Either way: backup tgz first (newest 5 kept), `dist`, `migrations` and `package.json` only, every plugin must come back `ready` at the expected version, then the smoke test (live worker state, one read-only tool, UI bundle, jobs, and journal errors that mean a bad release: restart noise and unrelated runtime errors are warnings, not a rollback), then `<plugin>.sync-skills` for every company, then a `DEPLOYED.json` stamp in each live plugin folder.
- Any failure after the first change rolls back from the backup and says so.
- **The CRM's `dist/ui/s/` is never touched.** The CRM writes its public signing pages and the signed copies of documents there while it runs, next to the files the build makes. The copy (`rsync --delete`), the restore and every content hash leave that folder out, and the plan prints `kept: dist/ui/s/ ...` for any batch with the CRM. If you ever add another runtime-written folder to a plugin's `dist/`, it has to be excluded in `deploy-plugins.sh` (`KEEP_RT`, and its content hashes) and in `plugin-versions-check.sh`, or a deploy will delete it and the stamp will call it drift.

## First install of a plugin that is not on the VPS yet

A plugin that is built and committed but has no installed row on the VPS (`plugin-ads`, key `partnersinbiz.ads`, is the first) is refused by a normal deploy. It is installed deliberately, by name, with:

```
deploy-plugins.sh --dry-run --first-install ads    # the plan and what it changes on the live host; stops before the VPS is touched
deploy-plugins.sh --first-install ads              # the install
```

It keeps every gate of a normal deploy (clean tree, pushed, typecheck, tests, build, manifest id and version, database dump, smoke test, skill sync for every company, `DEPLOYED.json`). A new plugin has no baseline, so every smoke check must pass after the install, and `--no-smoke` is refused together with `--first-install`. What a first install changes on the live host:

- **A new plugin with its own worker**, registered by `paperclipai plugin install --local /home/paperclip/pib-plugins/plugin-<name>` after the folder is copied. The script runs that call; you do not.
- **Every capability is new**, so it always takes the **stop-first** path: it waits until no agent run is in flight, stops Paperclip for the copy and starts it again. Run it at night, like any stop-first deploy.
- **New tables**: its migrations run for the first time, in the plugin's own namespace. A database dump is always taken first.
- **Its agent tools and skills** appear for every company after the skill sync. Nothing is switched on for any company: that stays a Setup step, done by the company's owner.

It cannot be combined with an installed plugin, with `all` or with `--rollback`. There is **no folder backup** (nothing existed) and **no baseline smoke run**, so after the install every smoke check must pass. If any check fails, the script **uninstalls the plugin again** (a soft uninstall: the host marks the row `uninstalled` and the tables and their data stay) and removes the folder, then verifies that the other plugins are untouched: exit 20. Exit 21 means the uninstall itself failed and a person is needed (the folder is not removed while the host still runs the plugin). Retrying after a rolled-back first install is allowed: the soft-deleted row is reused. A hard purge (`paperclipai plugin uninstall --force`) is for the owner to decide, never the script. After a successful first install the plugin is an ordinary one: the next change is `deploy-plugins.sh ads`.

A brand-new plugin other than `ads` first needs two edits in the PiB Paperclip repo: its name in `ALL_NAMES` in `deploy-plugins.sh` (otherwise the script says "unknown plugin") and a read-only tool in the `SMOKE` table of `smoke-plugins.sh`.

## When it refuses or stops

| Message | Do |
|---|---|
| uncommitted changes / HEAD is not in origin/development | commit, `git push origin development`, run again |
| version is already live | bump the version (`--allow-same-version` only to stamp or redeploy identical code) |
| not installed on the VPS | a new plugin: `deploy-plugins.sh --first-install <plugin>` (see above) |
| the folder `plugin-<name>` already exists but the host has no plugin for it | a half-finished install or a hand copy: look at it, remove it, run `--first-install` again |
| a migration was changed after the VPS applied it | never edit an applied migration; add a new one |
| runs still in flight after 45 min | try later, or `--force-restart` (interrupts them; the host queues a retry for each) |
| rolled back (exit 20) | read the log it printed (the `FAIL` lines name the check); fix; deploy again |
| deployed with warnings (`WARN` lines) | read them; they are things that did not stop the deploy: a new error signature in the journal, a check that was already failing before, a company where a module is not set up |
| exit 30 | deployed and live, but a company's skill sync failed: re-run `paperclipai plugin action partnersinbiz.<plugin> <plugin>.sync-skills` for that company |
| rollback did not verify (exit 21) | Paperclip may be down: `ssh root@65.108.146.144`, read `/root/pib-deploy/<id>/log`, then `deploy-plugins.sh --rollback` |

## After

- `deploy-plugins.sh --rollback [plugin...]` puts the newest backup back (stop-first).
- `plugin-versions-check.sh` compares live with `origin/development` (unstamped, dirty, modified, behind, not in git).
- `smoke-plugins.sh` (on the VPS) is read-only and safe any time.
- Never edit a migration that has been deployed, never rsync by hand, never deploy from a branch that is not on `origin/development`.
- The scripts have their own tests: `operations/vps/tests/release/run.sh` in the PiB Paperclip repo (fixture fork, fake VPS, mock API; nothing real is touched).
