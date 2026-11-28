#!/usr/bin/env python3
# PAR-15292 spike: same four run-record boundaries on live (read only) and dev. Not committed.
#  A  startedAt -> first legacy.case_handoff_cleanup_intent event   (agent_read .. workspace)
#  B  -> "run started" event                                          (github_environment, github_launchers)
#  C1 -> runs.runtimeModeResolvedAt                                   (run_output .. instructions, runtime_selection)
#  C2 -> first adapter log line "Reconciled ..."                      (execution.runtime admission, budget, adapter skill sync)
import json, os, sys, urllib.request, datetime as dt, pathlib, statistics
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
which = sys.argv[1]
if which == "live":
    api = os.environ["PAPERCLIP_API_URL"].rstrip("/") + "/api"
    H = {"Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"], "User-Agent": "curl/8.5.0"}
    LOGS = pathlib.Path("/home/paperclip/.paperclip/instances/default/data/run-logs")
    ids = sys.argv[2:]
else:
    api, H = "http://127.0.0.1:3193/api", {}
    LOGS = pathlib.Path("/home/paperclip/.paperclip-worktrees/instances/par-15292-voice-m1a-measure-the-preparation-phases-of-a-chat-run-stage-0a/data/run-logs")
    ids = [json.loads(l)["id"] for l in open(sys.argv[2]) if l.strip()]
def get(p):
    with urllib.request.urlopen(urllib.request.Request(api + p, headers=H), timeout=60) as r: return json.loads(r.read())
rows = []
for rid in ids:
    r = get(f"/heartbeat-runs/{rid}")
    ev = get(f"/heartbeat-runs/{r['id']}/events"); ev = ev if isinstance(ev, list) else ev.get("events", [])
    ci = next(ts(e["createdAt"]) for e in ev if e.get("eventType") == "legacy.case_handoff_cleanup_intent")
    rs = next(ts(e["createdAt"]) for e in ev if e.get("message") == "run started")
    log = next(LOGS.rglob(r["id"] + ".ndjson"))
    first = next(ts(json.loads(l)["ts"]) for l in open(log) if "Reconciled" in json.loads(l).get("chunk", ""))
    st, rm = ts(r["startedAt"]), ts(r["runtimeModeResolvedAt"])
    x = {"run": r["id"][:8], "queue": st - ts(r["createdAt"]), "A": ci - st, "B": rs - ci, "C1": rm - rs, "C2": first - rm, "prep": first - st}
    rows.append(x)
    print(" ".join(f"{k}={v:.2f}" if isinstance(v, float) else f"{k}={v}" for k, v in x.items()))
for k in ("A", "B", "C1", "C2", "prep"):
    v = [x[k] for x in rows]; print(f"{k:5s} median {statistics.median(v):.2f}  max {max(v):.2f}  n={len(v)}")
