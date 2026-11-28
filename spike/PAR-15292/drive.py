#!/usr/bin/env python3
# PAR-15292 spike: post N chat comments one at a time, wait for each run to end. Not committed.
import json, sys, time, uuid, urllib.request, pathlib
D = "http://127.0.0.1:3193/api"
S = pathlib.Path("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292")
st = json.loads((S / "state.json").read_text())
n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
qs = ["What is two plus two?", "Name one colour of the sky.", "Say hello in Afrikaans.", "What day comes after Monday?",
      "How many legs has a cat?", "Spell the word cat backwards.", "What is ten minus three?", "Name a fruit that is yellow."]

def call(method, path, body=None):
    req = urllib.request.Request(D + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "null")

def runs():
    return call("GET", f"/companies/{st['companyId']}/heartbeat-runs?agentId={st['agentId']}")

out = S / "runs.jsonl"
for i in range(n):
    seen = {r["id"] for r in runs()}
    q = qs[(len(open(out).readlines()) if out.exists() else 0) % len(qs)]
    c = call("POST", f"/issues/{st['issueId']}/comments", {
        "body": f"{q} One short sentence.\n\n_Sent by voice: reply in short spoken sentences._",
        "clientRequestId": str(uuid.uuid4())})
    t0 = time.time(); run = None
    while time.time() - t0 < 300:
        time.sleep(2)
        new = [r for r in runs() if r["id"] not in seen]
        if new and new[0]["status"] not in ("queued", "running"):
            run = new[0]; break
    rec = {"commentId": c["id"], "commentAt": c["createdAt"], **({k: run.get(k) for k in
           ("id", "status", "invocationSource", "triggerDetail", "createdAt", "startedAt", "finishedAt", "error")} if run else {"timeout": True})}
    with open(out, "a") as f: f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec)[:400], flush=True)
    time.sleep(3)
