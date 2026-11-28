#!/usr/bin/env python3
# PAR-15292 spike: per-phase table (median / slowest) from spans, cross-checked with run log. Not committed.
import json, sys, hashlib, pathlib, statistics, datetime as dt
S = pathlib.Path("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292")
LOGS = pathlib.Path("/home/paperclip/.paperclip-worktrees/instances/par-15292-voice-m1a-measure-the-preparation-phases-of-a-chat-run-stage-0a/data/run-logs")
spans = [json.loads(l) for l in open(S / "spans.ndjson") if l.strip()]
runs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
BUCKETS = {
    "workspace": ["heartbeat.prepare.workspace", "heartbeat.prepare.workspace_validation"],
    "skills (server inventory + materialize)": ["heartbeat.prepare.configuration_skills"],
    "instruction copy": ["heartbeat.prepare.instructions"],
    "prompt context (conversation, issue, task)": ["heartbeat.prepare.chat_completion", "heartbeat.prepare.conversation",
        "heartbeat.prepare.issue_context", "heartbeat.prepare.task_context"],
    "run identity": ["heartbeat.prepare.run_identity"],
    "github environment": ["heartbeat.prepare.github_environment", "heartbeat.prepare.github_launchers"],
    "config without skills (secrets, connectors, mentions)": None,  # execution_configuration - configuration_skills
    "session": ["heartbeat.prepare.session"],
    "other prepare phases": ["heartbeat.prepare.agent_read", "heartbeat.prepare.runtime_state", "heartbeat.prepare.trust_preset",
        "heartbeat.prepare.environment_selection", "heartbeat.prepare.run_output", "heartbeat.prepare.runtime_services",
        "heartbeat.prepare.runtime_selection"],
}
res = {k: [] for k in BUCKETS}; res["dispatch admission + adapter (to first log line)"] = []
res["unspanned gaps"] = []; res["check: spans start->runtime_selection end"] = []; res["check: record start->runtimeModeResolvedAt"] = []; res["TOTAL (spans)"] = []; res["TOTAL (run log: startedAt -> Reconciled)"] = []
for r in runs:
    h = hashlib.sha256(r["id"].encode()).hexdigest()[:12]
    mine = [s for s in spans if h in (s.get("attrs") or {}).values()]
    by = {}
    for s in mine: by.setdefault(s["name"], []).append(s)
    d = lambda n: sum(x["durMs"] for x in by.get(n, []))
    log = next(LOGS.rglob(r["id"] + ".ndjson"))
    first = next(ts(json.loads(l)["ts"]) for l in open(log) if "Reconciled" in json.loads(l).get("chunk", ""))
    start = ts(r["startedAt"])
    top = 0
    for k, names in BUCKETS.items():
        v = d("heartbeat.prepare.execution_configuration") - d("heartbeat.prepare.configuration_skills") if names is None else sum(d(n) for n in names)
        res[k].append(v); top += v
    last_prep_end = max(x["endMs"] for x in mine if x["name"].startswith("heartbeat.prepare."))
    adapter = first - last_prep_end
    res["dispatch admission + adapter (to first log line)"].append(adapter)
    gaps = (first - start) - top - adapter
    res["unspanned gaps"].append(gaps)
    res["TOTAL (spans)"].append(top + adapter + gaps)
    import urllib.request
    rec = json.loads(urllib.request.urlopen(f"http://127.0.0.1:3193/api/heartbeat-runs/{r['id']}").read())
    res["check: spans start->runtime_selection end"].append(max(x["endMs"] for x in by["heartbeat.prepare.runtime_selection"]) - start)
    res["check: record start->runtimeModeResolvedAt"].append(ts(rec["runtimeModeResolvedAt"]) - start)
    res["TOTAL (run log: startedAt -> Reconciled)"].append(first - start)
print(f"n={len(runs)} runs: {', '.join(r['id'][:8] for r in runs)}")
print(f"{'phase':58s} {'median':>8s} {'slowest':>8s}")
for k, v in res.items():
    print(f"{k:58s} {statistics.median(v):7.0f}ms {max(v):7.0f}ms")
