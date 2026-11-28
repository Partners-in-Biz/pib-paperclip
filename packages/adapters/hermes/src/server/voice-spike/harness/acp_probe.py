#!/usr/bin/env python3
"""Minimal ACP probe: start `hermes acp`, new session, one prompt. Usage: acp_probe.py HERMES_HOME CWD PROMPT"""
import json, os, subprocess, sys, time

home, cwd, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
env = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "HERMES_HOME": home, "LANG": "C.UTF-8", "BASH_ENV": os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-env.sh"), "PAPERCLIP_DIRECT_PROBE": "direct-ok", "HERMES_EPHEMERAL_SYSTEM_PROMPT": "Always end every reply with the word ZEBRA."}
t0 = time.time()
p = subprocess.Popen(["hermes", "acp", "--accept-hooks"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=open(os.path.join(os.path.dirname(__file__), "acp_probe.stderr"), "w"), env=env, cwd=cwd, text=True)
nid = [0]


def req(method, params):
    nid[0] += 1
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": nid[0], "method": method, "params": params}) + "\n")
    p.stdin.flush()
    text = ""
    while True:
        line = p.stdout.readline()
        if not line:
            raise SystemExit(f"exited during {method}")
        m = json.loads(line)
        if m.get("id") == nid[0] and "method" not in m:
            return m, text
        if m.get("method") == "session/update":
            u = m["params"]["update"]
            if u.get("sessionUpdate") == "agent_message_chunk":
                text += u["content"].get("text", "")
        elif "id" in m and m.get("method"):
            opts = m["params"].get("options", [])
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"outcome": {"outcome": "selected", "optionId": opts[0]["optionId"]}}}) + "\n")
            p.stdin.flush()


r, _ = req("initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
print("initialize", round(time.time() - t0, 1), "s", json.dumps(r)[:3000])
t1 = time.time()
r, _ = req("session/new", {"cwd": cwd, "mcpServers": []})
print("session/new", round(time.time() - t1, 1), "s", json.dumps(r)[:3000])
sid = r["result"]["sessionId"]
t2 = time.time()
r, text = req("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]})
print("prompt", round(time.time() - t2, 1), "s", json.dumps(r)[:300], "TEXT:", text[:500])
p.kill()
