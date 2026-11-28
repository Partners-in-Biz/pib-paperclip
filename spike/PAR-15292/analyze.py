#!/usr/bin/env python3
# PAR-15292 spike: per-run preparation phases from spans + run log. Not committed.
import json, sys, hashlib, pathlib, statistics, datetime as dt
S = pathlib.Path("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292")
LOGS = pathlib.Path("/home/paperclip/.paperclip-worktrees/instances/par-15292-voice-m1a-measure-the-preparation-phases-of-a-chat-run-stage-0a/data/run-logs")
spans = [json.loads(l) for l in open(S / "spans.ndjson") if l.strip()]
runs = [json.loads(l) for l in open(S / "runs.jsonl") if l.strip()]
ts = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000

def tree(run_hash):
    mine = [s for s in spans if (s.get("attrs") or {}).get("paperclip.run.id_hash") == run_hash
            or any(v == run_hash for v in (s.get("attrs") or {}).values())]
    return mine

detail = "-v" in sys.argv
for r in runs:
    if not r.get("id"): continue
    h = hashlib.sha256(r["id"].encode()).hexdigest()[:12]
    mine = sorted(tree(h), key=lambda s: s["startMs"])
    log = next(LOGS.rglob(r["id"] + ".ndjson"), None)
    lines = [json.loads(l) for l in open(log)] if log else []
    first = next((ts(o["ts"]) for o in lines if "Reconciled" in (o.get("chunk") or "")), None)
    start = ts(r["startedAt"])
    print(f"run {r['id'][:8]} status={r['status']} queue={(start-ts(r['createdAt']))/1000:.2f}s "
          f"prep(log: started->Reconciled)={(first-start)/1000 if first else float('nan'):.2f}s total={(ts(r['finishedAt'])-start)/1000:.2f}s spans={len(mine)}")
    top = [s for s in mine if s["name"].startswith("heartbeat.prepare.")]
    for s in top if not detail else mine:
        print(f"   {s['startMs']-start:8.0f} +{s['durMs']:8.1f} ms  {s['name']}")
