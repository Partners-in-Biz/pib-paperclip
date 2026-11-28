#!/usr/bin/env python3
# PAR-15292 spike: make the dev chat closer to live: 32 secret env bindings (dummy values),
# 300 earlier chat comments, 120 extra company skills. Dev instance only. Not committed.
import json, os, uuid, urllib.request, pathlib, subprocess
D = "http://127.0.0.1:3193/api"
S = pathlib.Path("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292")
st = json.loads((S / "state.json").read_text())
cid, aid, iid = st["companyId"], st["agentId"], st["issueId"]

def call(method, path, body=None):
    req = urllib.request.Request(D + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        print(method, path, e.code, e.read().decode()[:400]); raise

env = {"HERMES_HOME": {"type": "plain", "value": str(S / "hermes-home")}}
for i in range(32):
    sec = call("POST", f"/companies/{cid}/secrets", {"name": f"SPIKE_SECRET_{i}", "value": f"dummy-{uuid.uuid4()}"})
    env[f"SPIKE_SECRET_{i}"] = {"type": "secret_ref", "secretId": sec["id"]}
agent = call("GET", f"/agents/{aid}")
ac = agent["adapterConfig"]; ac["env"] = env
call("PATCH", f"/agents/{aid}", {"adapterConfig": ac})
print("secrets bound", len(env) - 1)

# 120 extra company skills, imported from the dev managed skill dir.
root = pathlib.Path("/home/paperclip/.paperclip-worktrees/instances/par-15292-voice-m1a-measure-the-preparation-phases-of-a-chat-run-stage-0a/skills") / cid
n = 0
for i in range(120):
    d = root / f"spike-extra-{i:03d}"; d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: spike-extra-{i:03d}\ndescription: Spike filler skill {i}.\n---\n\n# Filler {i}\n\n" + ("Text line.\n" * 200))
    call("POST", f"/companies/{cid}/skills/import", {"source": str(d)}); n += 1
print("extra skills", n)
