import sys, time, json, os, signal
sys.path.insert(0, __file__.rsplit("/",1)[0]); from acpc import *
home, sid, n, cold = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]=="cold"
for i in range(n):
    if cold:  # stop only OUR scratch gateway daemon (pid from scratch home), so process start includes a daemon start
        try:
            pid=json.load(open(home+"/gateway.pid"))["pid"]; os.kill(pid,signal.SIGTERM)
            for _ in range(60):
                time.sleep(0.5)
                try: os.kill(pid,0)
                except OSError: break
        except Exception as e: pass
    t0=time.time(); a=Acp(home)
    a.wait(a.send("initialize",INIT),120); t1=time.time()
    l=a.wait(a.send("session/load",{"cwd":home,"sessionId":sid,"mcpServers":[]}),300); t2=time.time()
    pr=a.wait(a.send("session/prompt",{"sessionId":sid,"prompt":[{"type":"text","text":"Reply with the single word OK."}]}),300); t3=time.time()
    print(json.dumps({"mode":"cold-daemon" if cold else "warm-daemon","try":i+1,"init_s":round(t1-t0,2),"session_load_s":round(t2-t1,2),"init_plus_load_s":round(t2-t0,2),"first_prompt_s":round(t3-t2,2),"ok":"error" not in l,"stop":(pr.get("result") or {}).get("stopReason"),"err":l.get("error") or pr.get("error")}),flush=True)
    a.close()
