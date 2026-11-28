#!/usr/bin/env python3
# PAR-15292 spike: seed the isolated dev instance. Not committed.
import json, os, shutil, sys, urllib.request, pathlib

D = "http://127.0.0.1:3193/api"
S = pathlib.Path("/home/paperclip/.hermes/profiles/claudesub/cache/scratch/par15292")
LIVE_SKILLS = pathlib.Path("/home/paperclip/.paperclip/instances/default/skills/b2b8f471-edba-4d05-abce-f15e99a94d9a")
LIVE_INSTR = pathlib.Path("/home/paperclip/.paperclip/instances/default/companies/b2b8f471-edba-4d05-abce-f15e99a94d9a/agents/012aeb07-c18c-4566-b8cb-4a79e1ba5aad/instructions")
SKILLS = ["pib-git-workflow", "tdd", "diagnosing-bugs", "pr", "code-review", "transcribe-audio", "github", "pib-autonomy"]

def call(method, path, body=None):
    req = urllib.request.Request(D + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            t = r.read().decode()
            return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        print(method, path, e.code, e.read().decode()[:600]); raise

state = {}
co = call("POST", "/companies", {"name": "Voice Prep Spike"})
state["companyId"] = cid = co["id"]

# Copies only: the dev instance never reads or writes live skill folders.
src = pathlib.Path("/home/paperclip/.paperclip-worktrees/instances/par-15292-voice-m1a-measure-the-preparation-phases-of-a-chat-run-stage-0a/skills") / cid; src.mkdir(parents=True, exist_ok=True)
keys = []
for name in SKILLS:
    dst = src / name
    if not dst.exists():
        shutil.copytree(LIVE_SKILLS / name, dst, symlinks=False, ignore=shutil.ignore_patterns(".git"))
    res = call("POST", f"/companies/{cid}/skills/import", {"source": str(dst)})
    imported = res.get("imported") or res.get("skills") or [res]
    for sk in imported:
        if isinstance(sk, dict) and sk.get("key"): keys.append(sk["key"])
print("skills", keys)

files = {}
for p in LIVE_INSTR.rglob("*"):
    if p.is_file(): files[str(p.relative_to(LIVE_INSTR))] = p.read_text()
hh = S / "hermes-home"; hh.mkdir(exist_ok=True)
shutil.copy("/home/paperclip/.hermes/profiles/claudesub/config.yaml", hh / "config.yaml")
shutil.copy("/home/paperclip/.hermes/profiles/claudesub/SOUL.md", hh / "SOUL.md")

agent = call("POST", f"/companies/{cid}/agents", {
    "name": "Leo", "role": "engineer", "adapterType": "hermes_local",
    "desiredSkills": keys,
    "adapterConfig": {
        "model": "claude-haiku-5-5", "provider": "claude-subscription-directsdk-experimental",
        "extraArgs": ["--provider", "claude-subscription-directsdk-experimental"],
        "timeoutSec": 600, "hermesCommand": shutil.which("hermes"), "persistSession": True,
        "env": {"HERMES_HOME": {"type": "plain", "value": str(hh)}},
    },
    "instructionsBundle": {"entryFile": "AGENTS.md", "files": files},
})
state["agentId"] = aid = agent["id"]
chat = call("POST", f"/companies/{cid}/chats/{aid}")
state["issueId"] = chat["id"]
(S / "state.json").write_text(json.dumps(state, indent=1))
print(json.dumps(state), "files", len(files), "status", agent.get("status"))
