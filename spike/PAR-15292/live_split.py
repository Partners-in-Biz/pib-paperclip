#!/usr/bin/env python3
# PAR-15292 spike: READ-ONLY split of live chat runs by run-event/log timestamps. Not committed.
# A = startedAt -> first "legacy.case_handoff_cleanup_intent" event (prepare: agent_read .. workspace)
# B = that event -> "run started" (github_environment, github_launchers)
# C = "run started" -> first adapter log line (run_output, runtime_services, instructions, runtime_selection, adapter skill reconcile)
import json, os, sys, urllib.request, datetime as dt, statistics, pathlib
api = os.environ["PAPERCLIP_API_URL"].rstrip("/") + "/api"
H = {"Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"], "User-Agent": "curl/8.5.0"}
CO = "b2b8f471-edba-4d05-abce-f15e99a94d9a"
LOGS = pathlib.Path("/home/paperclip/.paperclip/instances/default/data/run-logs") / CO
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def get(p):
    with urllib.request.urlopen(urllib.request.Request(api + p, headers=H), timeout=60) as r:
        return json.loads(r.read())

agents = sys.argv[1:]
rows = []
for ag in agents:
    runs = get(f"/companies/{CO}/heartbeat-runs?agentId={ag}&limit=200")[:70]
    for r in runs:
        if not r.get("startedAt") or r.get("status") != "succeeded": continue
        try: r = get(f"/heartbeat-runs/{r['id']}")
        except Exception: continue
        cs = r.get("contextSnapshot") or {}
        if cs.get("wakeReason") not in ("issue_commented", "issue_reopened_via_comment"): continue
        chat = bool(cs.get("conversationMode") or "conversationSessionGeneration" in cs)
        try: ev = get(f"/heartbeat-runs/{r['id']}/events")
        except Exception: continue
        ev = ev if isinstance(ev, list) else ev.get("events", [])
        ci = next((ts(e["createdAt"]) for e in ev if e.get("eventType") == "legacy.case_handoff_cleanup_intent"), None)
        rs = next((ts(e["createdAt"]) for e in ev if e.get("message") == "run started"), None)
        log = LOGS / ag / (r["id"] + ".ndjson")
        first = None
        if log.exists():
            for l in open(log):
                o = json.loads(l)
                if "Reconciled" in (o.get("chunk") or "") or "[hermes]" in (o.get("chunk") or ""):
                    first = ts(o["ts"]); break
        st = ts(r["startedAt"])
        if not (ci and rs and first): continue
        rows.append({"agent": ag[:8], "run": r["id"][:8], "at": r["startedAt"][:16], "queue": st - ts(r["createdAt"]), "chat": chat,
                     "A": ci - st, "B": rs - ci, "C": first - rs, "prep": first - st})
        json.dump(rows, open("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292/live_split.json", "w"), indent=1)
        if len([x for x in rows if x["agent"] == ag[:8]]) >= 12: break
import signal
for x in rows:
    print(f"{x['agent']} {x['run']} chat={int(x['chat'])} {x['at']} queue={x['queue']:.2f} A={x['A']:.2f} B={x['B']:.2f} C={x['C']:.2f} prep={x['prep']:.2f}")
for k in ("A", "B", "C", "prep"):
    v = [x[k] for x in rows]
    if v: print(k, "median", round(statistics.median(v), 2), "max", round(max(v), 2), "n", len(v))
json.dump(rows, open("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292/live_split.json", "w"), indent=1)
