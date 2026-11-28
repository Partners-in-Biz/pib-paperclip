#!/usr/bin/env python3
"""PAR-15293 spike driver: runs plan section 7 "Stage 3, identity" against the dev instance."""
import json, os, sys, time, urllib.request, urllib.error, glob

API = "http://127.0.0.1:3194/api"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")
HOSTS = os.path.join(HERE, "hosts")


def call(method, path, body=None, headers=None, base=API, token=None):
    url = path if path.startswith("http") else base + path
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json", "accept": "application/json"}
    if token:
        h["authorization"] = f"Bearer {token}"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:300]


def load():
    return json.load(open(STATE)) if os.path.exists(STATE) else {}


def save(s):
    json.dump(s, open(STATE, "w"), indent=2)


def runs(s):
    st, rows = call("GET", f"/companies/{s['companyId']}/heartbeat-runs?agentId={s['agentId']}")
    return rows if isinstance(rows, list) else rows.get("items", rows)


def wait_new_run(s, known, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for r in runs(s):
            if r["id"] not in known:
                return r
        time.sleep(1)
    raise SystemExit("no new run")


def wait_done(run_id, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, r = call("GET", f"/heartbeat-runs/{run_id}")
        if r.get("status") in ("succeeded", "failed", "cancelled", "timed_out"):
            return r
        time.sleep(1)
    raise SystemExit(f"run {run_id} not done")


def wait_status(run_id, statuses, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, r = call("GET", f"/heartbeat-runs/{run_id}")
        if r.get("status") in statuses:
            return r
        time.sleep(0.5)
    raise SystemExit(f"run {run_id} never reached {statuses}")


def host_state(chat):
    for f in glob.glob(os.path.join(HOSTS, "*.json")):
        d = json.load(open(f))
        if d["key"].endswith(":" + chat):
            return d
    return None


def proc_env(pid):
    raw = open(f"/proc/{pid}/environ", "rb").read().split(b"\0")
    return dict(x.decode(errors="replace").split("=", 1) for x in raw if b"=" in x)


def turn(s, issue_key, body):
    chat = "A" if issue_key == "issueA" else "B"
    known = {r["id"] for r in runs(s)}
    t0 = time.time()
    st, iss = call("POST", f"/companies/{s['companyId']}/issues", {"title": f"chat-{chat} turn {int(t0)}", "status": "backlog"})
    assert st in (200, 201), (st, iss)
    st, _ = call("PATCH", f"/issues/{iss['id']}", {"description": body.replace("{ISSUE}", iss["id"]), "status": "todo",
        "assigneeAgentId": s["agentId"]})
    assert st == 200, st
    s[issue_key] = iss["id"]; save(s)
    t1 = time.time()
    while time.time() - t1 < 180:
        for r in runs(s):
            if r["id"] not in known and (r.get("contextSnapshot") or {}).get("issueId") == iss["id"]:
                return r, t0
        time.sleep(0.5)
    raise SystemExit("no run for the new issue")


def cmd_turn1(s):
    known = {r["id"] for r in runs(s)}
    body = ("Turn 1. Run this in the terminal and report its exact output in one line: "
            "`printenv PAPERCLIP_API_URL; test -n \"$PAPERCLIP_API_KEY\" && echo key-present; "
            "printenv PAPERCLIP_RUN_ID || echo no-run-id; curl -s -o /dev/null -w '%{http_code}' "
            "-H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \"$PAPERCLIP_API_URL/api/agents/me\"`")
    st, iss = call("PATCH", f"/issues/{s['issueA']}", {"assigneeAgentId": s["agentId"], "description": body})
    print("assign", st)
    run = wait_new_run(s, known)
    print("run1", run["id"], run.get("invocationSource"), run.get("triggerDetail"))
    r = wait_done(run["id"])
    print("run1 status", r["status"], (r.get("resultJson") or {}).get("result"), (r.get("resultJson") or {}).get("voiceSpike"))
    s["run1"] = run["id"]; save(s)



LOG = os.path.join(HERE, "results.jsonl")


def rec(name, ok, **detail):
    line = {"check": name, "pass": ok, **detail}
    print(("PASS " if ok else "FAIL ") + name, json.dumps(detail)[:600])
    with open(LOG, "a") as f:
        f.write(json.dumps(line) + "\n")


def comments(s, key):
    st, rows = call("GET", f"/issues/{s[key]}/comments")
    return rows if isinstance(rows, list) else rows.get("items", [])


def bridge_creds(chat):
    h = host_state(chat)
    if not h:
        return None, None, None
    e = proc_env(h["pid"])
    return h, e.get("PAPERCLIP_API_URL"), e.get("PAPERCLIP_API_KEY")


def do_turn(s, key, body, label):
    run, t0 = turn(s, key, body)
    r = wait_done(run["id"])
    rj = r.get("resultJson") or {}
    print(label, run["id"], r["status"], round(time.time() - t0, 1), "s", (rj.get("voiceSpike")), "|", (rj.get("result") or "")[:300].replace("\n", " "))
    return run["id"], r


def cmd_t1(s):
    rid, r = do_turn(s, "issueA", ("Turn 1. Run this single shell command and reply with its exact output on one line: "
        "`printenv PAPERCLIP_RUN_ID || echo no-run-id-in-shell`, then the same with the env file sourced: "
        "`printenv PAPERCLIP_API_URL; curl -s -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \"$PAPERCLIP_API_URL/api/agents/me\"`"), "t1")
    s["run1"] = rid; save(s)
    h, url, tok = bridge_creds("A")
    e = proc_env(h["pid"])
    rec("env: warm process has no run id and no run token", "PAPERCLIP_RUN_ID" not in e and tok != None and not tok.startswith("ey"),
        keys=sorted(k for k in e if k.startswith("PAPERCLIP_")), apiUrlIsLoopbackBridge=url == h["bridgeUrl"])
    s["bridgeA"] = {"url": url, "token": tok, "pid": h["pid"]}; save(s)


def cmd_t2(s):
    quiesce(s)
    nonce = f"turn-2-write-{int(time.time())}"
    rid, r = do_turn(s, "issueA", (f"Turn 2. Using the Paperclip API, post a comment on issue {{ISSUE}} whose body is exactly `{nonce}` "
        "(POST /api/issues/<id>/comments with JSON {\"body\": ...}). Then reply with the HTTP status you got."), "t2")
    s["run2"] = rid; save(s)
    hit = [c for c in comments(s, "issueA") if (c.get("body") or "").strip() == nonce]
    c = hit[0] if hit else {}
    rec("turn 2 write recorded under turn 2's run", bool(hit) and c.get("createdByRunId") == rid and c.get("authorAgentId") == s["agentId"],
        run2=rid, run1=s.get("run1"), commentCreatedByRunId=c.get("createdByRunId"), authorAgentId=c.get("authorAgentId"))


def quiesce(s, hold=8, timeout=240):
    t0 = time.time(); calm = None
    while time.time() - t0 < timeout:
        active = [r for r in runs(s) if r["status"] in ("queued", "running", "scheduled_retry")]
        bound = [h for h in (host_state("A"), host_state("B")) if h and h["binding"]]
        if not active and not bound:
            calm = calm or time.time()
            if time.time() - calm >= hold:
                return
        else:
            calm = None
        time.sleep(1)
    raise SystemExit("never quiet")


def cmd_between(s):
    quiesce(s)
    h, url, tok = bridge_creds("A")
    s["bridgeA"] = {"url": url, "token": tok, "pid": h["pid"]}; save(s)
    b = s["bridgeA"]
    st1, body1 = call("GET", b["url"] + "/api/agents/me", token=b["token"])
    st2, body2 = call("POST", b["url"] + f"/api/issues/{s['issueA']}/comments", {"body": "between-turns-should-fail"}, token=b["token"])
    rec("request between turns gets 403", st1 == 403 and st2 == 403, binding=h["binding"], get=[st1, body1], post=[st2, body2])
    st3, body3 = call("GET", "/agents/me", token=b["token"])
    rec("bridge token refused by the server itself", st3 == 401, status=st3, body=body3)
    st4, body4 = call("GET", b["url"] + "/api/agents/me", token="wrong-token")
    rec("wrong token refused at the bridge", st4 == 401, status=st4, body=body4)


def cmd_t3cancel(s):
    quiesce(s)
    nonce = f"turn-3-late-{int(time.time())}"
    run, t0 = turn(s, "issueA", (f"Turn 3. In ONE shell command run: `sleep 25` and then post a comment on issue {{ISSUE}} with body `{nonce}` "
        "through the Paperclip API. Reply with the HTTP status."))
    rid = run["id"]; s["run3"] = rid; save(s)
    wait_status(rid, ["running"])
    t1 = time.time()
    while time.time() - t1 < 60:
        h = host_state("A")
        if h and h["binding"] == rid:
            break
        time.sleep(0.5)
    time.sleep(10)  # the agent is now inside `sleep 25`
    h, url, tok = bridge_creds("A")
    s["bridgeA"] = {"url": url, "token": tok, "pid": h["pid"]}; save(s)
    b = s["bridgeA"]
    st_before, _ = call("GET", b["url"] + "/api/agents/me", token=b["token"])
    stc, bc = call("POST", f"/heartbeat-runs/{rid}/cancel", {})
    print("cancel", stc, str(bc)[:200])
    time.sleep(0.3)
    st_after, body_after = call("POST", b["url"] + f"/api/issues/{s['issueA']}/comments", {"body": "during-cancelled-turn"}, token=b["token"])
    st_after_get, _ = call("GET", b["url"] + "/api/agents/me", token=b["token"])
    r = wait_done(rid)
    time.sleep(30)
    late = [c for c in comments(s, "issueA") if (c.get("body") or "").strip() in (nonce, "during-cancelled-turn")]
    h = host_state("A")
    alive = os.path.exists(f"/proc/{b['pid']}")
    rec("request during a cancelled turn gets 403", st_before == 200 and st_after in (401, 403) and st_after_get in (401, 403) and not late,
        bridgeWhileBound=st_before, postAfterCancel=[st_after, body_after], getAfterCancel=st_after_get,
        runStatus=r["status"], lateWritesLanded=len(late), voiceSpike=(r.get("resultJson") or {}).get("voiceSpike"),
        hostProcessAlive=alive)


def cmd_t4(s):
    quiesce(s)
    rid, r = do_turn(s, "issueA", "Turn 4. What exact comment body did I ask you to post in turn 2? Reply with it only.", "t4")
    s["run4"] = rid; save(s)
    h, url, tok = bridge_creds("A")
    rec("turn after cancel succeeds; session kept", r["status"] == "succeeded", run=rid, newProcess=(h or {}).get("pid") != s["bridgeA"]["pid"],
        reply=((r.get("resultJson") or {}).get("result") or "")[:200], voiceSpike=(r.get("resultJson") or {}).get("voiceSpike"))
    if tok:
        s["bridgeA"] = {"url": url, "token": tok, "pid": h["pid"]}; save(s)


def cmd_cross(s):
    quiesce(s)
    # Chat B gets its own process and bridge. While B is bound, A's token is refused at B.
    run, t0 = turn(s, "issueB", "Chat B turn 1. Run `sleep 20` in the terminal, then reply ok.")
    rid = run["id"]; s["runB1"] = rid; save(s)
    t1 = time.time()
    hb = None
    while time.time() - t1 < 90:
        hb = host_state("B")
        if hb and hb["binding"] == rid:
            break
        time.sleep(0.5)
    eb = proc_env(hb["pid"])
    ha, ua, ta = bridge_creds("A")
    a = {"url": ua, "token": ta, "pid": ha["pid"]} if ha and os.path.exists(f"/proc/{ha['pid']}") else s["bridgeA"]
    st_a_at_b, body = call("GET", hb["bridgeUrl"] + "/api/agents/me", token=a["token"])
    st_b_at_b, me = call("GET", hb["bridgeUrl"] + "/api/agents/me", token=eb["PAPERCLIP_API_KEY"])
    st_b_at_a, body2 = call("GET", a["url"] + "/api/agents/me", token=eb["PAPERCLIP_API_KEY"])
    r = wait_done(rid)
    rec("bridge token refused by another process's bridge", st_a_at_b == 401 and st_b_at_b == 200 and st_b_at_a in (401, 403),
        aTokenAtB=[st_a_at_b, body], bTokenAtB=st_b_at_b, bTokenAtA=[st_b_at_a, body2], distinctPids=hb["pid"] != a["pid"], runB=r["status"])

if __name__ == "__main__":
    cmd = sys.argv[1]
    s = load()
    if cmd == "setup":
        st, co = call("POST", "/companies", {"name": "Voice spike PAR-15293"})
        print("company", st, co.get("id") if isinstance(co, dict) else co)
        s["companyId"] = co["id"]
        instr = os.path.join(HERE, "AGENTS.md")
        st, ag = call("POST", f"/companies/{s['companyId']}/agents", {
            "name": "Spike Voice Agent", "role": "engineer",
            "adapterType": "hermes_local",
            "adapterConfig": {
                "hermesCommand": "/home/paperclip/.hermes/hermes-agent/.hermes/bin/hermes",
                "model": "claude-sonnet-5-5", "provider": "claude-subscription-directsdk-experimental",
                "persistSession": True, "timeoutSec": 300, "spikeVoiceWarm": True,
                "instructionsFilePath": instr,
                "env": {"HERMES_HOME": "/home/paperclip/.hermes/profiles/claudesub-dev"},
            },
        })
        print("agent", st, ag.get("id") if isinstance(ag, dict) else ag)
        s["agentId"] = ag["id"]
        for key, title in (("issueA", "Voice chat A"), ("issueB", "Voice chat B")):
            st, iss = call("POST", f"/companies/{s['companyId']}/issues", {"title": title, "status": "todo"})
            print(key, st, iss.get("identifier") if isinstance(iss, dict) else iss)
            s[key] = iss["id"]
        save(s)
    elif cmd == "show":
        print(json.dumps(s, indent=2))
    else:
        globals()["cmd_" + cmd](s)

