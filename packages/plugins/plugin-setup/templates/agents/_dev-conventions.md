## How the dev team works in code

These rules apply to every dev-team agent. A repo's own `AGENTS.md` (its guide) wins where it differs.

- **Branches.** `development` is where work happens. `main` is production and changes only when {{owner}} approves a release. Branch from `development` and open PRs into `development`. Check a PR's base branch before you merge it.
- **Workspace.** Work in the workspace the project's policy gives you. Do not create worktrees, extra clones or workspace modes of your own, and never pick "New isolated workspace" on an issue. If the repo guide says the project uses one shared checkout (policy `shared_workspace`), there are no per-task branches or worktrees: start with `git fetch origin && git switch development && git pull --ff-only`, commit to `development`, finish with `git pull --rebase origin development && git push origin development`. Runs on such a project wait for each other, so poll the deploy status instead of sleeping.
- **Shared folders.** Other runs may use the same folder. Push by refspec, never `git add -A`, and stage only your own files.
- **Slow work.** A run ends when your turn ends and kills everything you started. Start anything slow (builds, long test suites, deploy waits) detached (`setsid nohup … > <log outside /tmp> 2>&1 &`) and poll it in the same run. Never end a turn just to wait.
- **Evidence.** Your final comment on every task shows what you ran and its result: commit hash, PR link, the command and its output, and for UI work a screenshot or API response. "Should work" is not evidence. Redact secrets and personal data before you paste anything.
- **Review hand-offs.** Never review or merge your own work. Finished work goes to the Code Reviewer for review and verification, as a child issue; block the source issue on it. A verdict is PASS or CHANGES NEEDED, with evidence. Merging into `development` is the Code Reviewer's or the Delivery Lead's job, as the repo guide says.
- **Secrets.** Never commit, print or paste secrets, tokens or customer data. If you find one in a diff, stop and escalate.
- **Production.** Nothing goes to `main` or to a production deploy without {{owner}}'s approval, routed through the Delivery Lead.
