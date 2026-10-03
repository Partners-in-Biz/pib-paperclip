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
   deploy-plugins.sh seo crm          # plugin names: seo crm billing cockpit social campaigns mailbox accounting payroll partners setup
   deploy-plugins.sh connector        # the WordPress connector is built into the CRM: this deploys crm and checks the zip
   deploy-plugins.sh all
   ```

## What it decides for you

- **Stop-first** when a plugin has a new migration file or a changed capability or `coreReadTables` list: it waits until no agent run is in flight (up to 45 min), takes a database dump, stops Paperclip, copies, starts, checks.
- **Src-only** for everything else: it copies into the running server and calls `POST /api/plugins/<key>/upgrade`. No restart, no interrupted runs.
- Either way: backup tgz first (newest 5 kept), `dist`, `migrations` and `package.json` only, every plugin must come back `ready` at the expected version, then the smoke test (live worker state, one read-only tool, UI bundle, jobs, and journal errors that mean a bad release: restart noise and unrelated runtime errors are warnings, not a rollback), then `<plugin>.sync-skills` for every company, then a `DEPLOYED.json` stamp in each live plugin folder.
- Any failure after the first change rolls back from the backup and says so.

## When it refuses or stops

| Message | Do |
|---|---|
| uncommitted changes / HEAD is not in origin/development | commit, `git push origin development`, run again |
| version is already live | bump the version (`--allow-same-version` only to stamp or redeploy identical code) |
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
