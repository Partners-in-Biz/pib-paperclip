# Minimal ACP JSON-RPC client over stdio for `hermes acp`. Throwaway spike code (PAR-15294).
import json, subprocess, sys, time, os, threading, queue
class Acp:
    def __init__(s, home):
        env = dict(os.environ, HERMES_HOME=home)
        s.t0 = time.time()
        s.p = subprocess.Popen(["hermes","acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=open(home+"/acp.stderr","a"), env=env, text=True, bufsize=1)
        s.q = queue.Queue(); s.n = 0; s.events = []
        threading.Thread(target=s._rd, daemon=True).start()
    def _rd(s):
        for line in s.p.stdout:
            try: m = json.loads(line)
            except Exception: continue
            m["_t"] = time.time(); s.q.put(m)
    def send(s, method, params, note=False):
        s.n += 1; m = {"jsonrpc":"2.0","method":method,"params":params}
        if not note: m["id"] = s.n
        s.p.stdin.write(json.dumps(m)+"\n"); s.p.stdin.flush(); return s.n
    def wait(s, rid, timeout=300, on_msg=None):
        end = time.time()+timeout
        while time.time() < end:
            try: m = s.q.get(timeout=0.2)
            except queue.Empty:
                if on_msg: on_msg(None)
                continue
            if m.get("id") == rid and "method" not in m: return m
            if on_msg: on_msg(m)
            if m.get("method") == "session/request_permission" :  # deny anything asking
                s.p.stdin.write(json.dumps({"jsonrpc":"2.0","id":m["id"],"result":{"outcome":{"outcome":"cancelled"}}})+"\n"); s.p.stdin.flush()
        raise TimeoutError(rid)
    def close(s):
        try: s.p.stdin.close(); s.p.wait(timeout=10)
        except Exception: s.p.kill()
INIT = {"protocolVersion":1,"clientCapabilities":{}}
