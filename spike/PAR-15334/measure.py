# Throwaway (PAR-15334): call start -> session loaded, service not running / side by side / already running.
import sys, os, json, time, signal, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from acpc import *; from env import fixed_env
HB = "/home/paperclip/.hermes/hermes-agent/.hermes/bin/hermes"
home, sid, mode, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
SVC_ARGS = sys.argv[5:]  # extra args for the service in side/warm modes


def svc_pid():
    try: return json.load(open(home + "/gateway.pid"))["pid"]
    except Exception: return None


def alive(p):
    try: os.kill(p, 0); return True
    except OSError: return False


def stop_svc():
    p = svc_pid()
    if p and alive(p):
        os.kill(p, signal.SIGTERM)
        for _ in range(120):
            if not alive(p): break
            time.sleep(0.5)
        if alive(p): os.kill(p, signal.SIGKILL); time.sleep(1)


def start_svc():
    return subprocess.Popen([HB, "gateway", "run", "--quiet", *SVC_ARGS], env=fixed_env(home), stdin=subprocess.DEVNULL,
                            stdout=open(home + "/svc.out", "ab"), stderr=subprocess.STDOUT, start_new_session=True)


def ready():
    try: st = json.load(open(home + "/gateway_state.json"))
    except Exception: return False
    return st.get("gateway_state") == "running" and alive(st["pid"])


def rss(p):
    try: return int(open(f"/proc/{p}/status").read().split("VmRSS:")[1].split()[0]) // 1024
    except Exception: return None


stop_svc()
for i in range(n):
    stop_svc(); time.sleep(1)
    sp = None
    if mode == "warm":
        sp = start_svc(); t = time.time()
        while not ready() and time.time() - t < 120: time.sleep(0.2)
        time.sleep(1)
    t0 = time.time()
    if mode == "side": sp = start_svc()
    a = Acp(home, fixed_env(home))
    err = None
    try:
        a.wait(a.send("initialize", INIT), 180); t1 = time.time()
        l = a.wait(a.send("session/load", {"cwd": home, "sessionId": sid, "mcpServers": []}), 300); t2 = time.time()
        err = l.get("error")
    except Exception as e:
        t1 = t2 = time.time(); err = repr(e)
    p = svc_pid()
    print(json.dumps({"mode": mode, "try": i + 1, "init_s": round(t1 - t0, 2), "load_s": round(t2 - t1, 2), "total_s": round(t2 - t0, 2),
                      "ok": err is None, "err": str(err)[:200] if err else None, "svc_rss_mb": rss(p) if p else None}), flush=True)
    a.close(); stop_svc()
    if sp and sp.poll() is None: sp.terminate()
print("left:", bool(svc_pid() and alive(svc_pid())), flush=True)
