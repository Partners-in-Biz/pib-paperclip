# Throwaway (PAR-15334): does the service stay up past 600 s? kind=attached (service --idle-exit + attached acp) | idle (service without --idle-exit, no client)
import sys, os, json, time, subprocess, signal
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from acpc import *; from env import fixed_env
HB = "/home/paperclip/.hermes/hermes-agent/.hermes/bin/hermes"
home, sid, kind, secs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def pid():
    try: return json.load(open(home + "/gateway.pid"))["pid"]
    except Exception: return None
def alive(p):
    try: os.kill(p, 0); return True
    except OSError: return False
extra = ["--idle-exit"] if kind == "attached" else []
sp = subprocess.Popen([HB, "gateway", "run", "--quiet", *extra], env=fixed_env(home), stdin=subprocess.DEVNULL,
                      stdout=open(home + "/svc.out", "ab"), stderr=subprocess.STDOUT, start_new_session=True)
time.sleep(12); p = pid(); t0 = time.time(); a = None
if kind == "attached":
    a = Acp(home, fixed_env(home)); a.wait(a.send("initialize", INIT), 180)
    l = a.wait(a.send("session/load", {"cwd": home, "sessionId": sid, "mcpServers": []}), 300)
    print("loaded", "error" not in l, flush=True)
print(kind, "service pid", p, "alive", alive(p), flush=True)
while time.time() - t0 < secs:
    time.sleep(30); print(kind, int(time.time() - t0), "s alive", alive(p), flush=True)
    if not alive(p): break
if a: a.close()
os.kill(p, signal.SIGTERM)
for _ in range(60):
    if not alive(p): break
    time.sleep(0.5)
print(kind, "final: stopped by me", not alive(p), flush=True)
