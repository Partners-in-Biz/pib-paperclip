# Task-list time before and after stage C (PAR-12747, AC-L12)

Spec PAR-12608 section 8, AC-L12: the owner's task list on a company of PAR's size may be at most 10 percent slower than before stage C. Scripts: `server/scripts/seed-task-list-company.ts`, `server/scripts/measure-task-list-time.ts` (method in the file headers).

## Scope

The seeded owner is not restricted, so the `report` and `enforce` rows measure the resolver's overhead for an unrestricted member only. They do not measure a restricted operator's list; that row is not measured.

## Method

Two real servers (`authenticated` mode, own throwaway home and embedded PostgreSQL, `HEARTBEAT_SCHEDULER_ENABLED=false`): before = `8d8cb119a` (last commit before stage C), after = `fbd7d443f`. The same company (13,200 tasks, 79,200 comments, 129 projects, 38 paused agents, 8 members) was seeded into both. 10 warm-up rounds, then 100 counted rounds per mode; order flips every round; only `X-Paperclip-Request-Cache: miss` responses count; both servers returned identical bodies. Host: 16 cores, load 11 to 14 (shared VPS), Node v24.22.2, 2026-11-18.

## Results (ms, medians of 100 samples)

| Mode | Request | Rows | Before | After | Change | AC-L12 |
|---|---|---|---|---|---|---|
| off | issues-page-compact | 100 | 470.9 | 471.8 | +0.2% | pass |
| off | issues-page-index | 100 | 373.3 | 376.9 | +1.0% | pass |
| off | list-all-page | 500 | 156.7 | 166.5 | +6.3% | pass |
| report | issues-page-compact | 100 | 476.6 | 471.3 | -1.1% | pass |
| report | issues-page-index | 100 | 370.4 | 375.1 | +1.3% | pass |
| report | list-all-page | 500 | 151.2 | 161.4 | +6.7% | pass |
| enforce | issues-page-compact | 100 | 467.6 | 464.0 | -0.8% | pass |
| enforce | issues-page-index | 100 | 372.6 | 370.4 | -0.6% | pass |
| enforce | list-all-page | 500 | 149.9 | 156.3 | +4.3% | pass |

## Safety of the scripts

The seed writes only to a loopback database with no query string in its url (postgres.js lets `?host=` or `?hostaddr=` override the url host) whose name is `paperclip_measure` or `measure_*`; any other name needs `--confirm-database=<name>`. The measure script sends the owner's token only over https or http to loopback. Guards and tests: `server/scripts/lib/measure-guards.mjs`, `server/scripts/measure-guards.test.mjs`.
