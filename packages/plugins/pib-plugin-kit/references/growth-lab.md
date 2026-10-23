# Growth Lab: what works, per scope

Shared reference for every plugin that runs the Growth Lab loop (Social today; Campaigns, SEO and Cockpit when they declare a `measure-experiments` job; Ads once it is installed). A plugin skill may point here instead of repeating the loop. The tools below come from the kit's `growthToolDeclarations`.

## The loop

1. **Review.** `performance-review` (one scope): top and bottom items with features and lift, running experiments, pending playbook changes, hypothesis types ranked by UCB.
2. **Plan from the playbook.** `get-playbook` before planning. The playbook is the scope's rules in markdown.
3. **Experiment.** `propose-experiment` changes one variable: a `hypothesisType` such as `hook:question`, arms `control` and `variant`. Max 3 running per scope. A person approves it with `approve-experiment` or declines with `reject-experiment`, unless the scope's autopilot is full.
4. **Measure.** The daily `measure-experiments` job decides win, loss, no change or inconclusive and drafts a playbook change for a win or a loss.
5. **Playbook.** `propose-playbook-change` (add, remove or replace a rule) with a reason. `decide-playbook-change` keeps (new version) or discards.

## Rules for agents

- Pass the scope you are working in on every call. Never read or write another scope's playbook, experiments or reviews.
- Never approve, reject or decide your own proposal unless the scope's autopilot is full.
- Never invent results. If an arm is not measured yet, say "not measured yet".
- `list-experiments` shows arms, counts per arm and verdicts.
