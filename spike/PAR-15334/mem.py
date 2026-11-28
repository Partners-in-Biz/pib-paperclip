# Throwaway (PAR-15334): memory of a kept-running service: idle, with loaded session, 60 s later; plus the acp process.
import sys, os, json, time, subprocess, signal
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from acpc import *; from env import fixed_env
HB="/home/paperclip/.hermes/hermes-agent/.hermes/bin/hermes"; home,sid=sys.argv[1:3]
def rss(p): return int(open(f"/proc/{p}/status").read().split("VmRSS:")[1].split()[0])//1024
def tree(p):
    t=[p]; 
    for c in subprocess.run(["pgrep","-P",str(p)],capture_output=True,text=True).stdout.split(): t+=tree(int(c))
    return t
sp=subprocess.Popen([HB,"gateway","run","--quiet"],env=fixed_env(home),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.STDOUT,start_new_session=True)
time.sleep(20); p=json.load(open(home+"/gateway.pid"))["pid"]
out={"idle_20s_mb":rss(p),"idle_tree_mb":sum(rss(x) for x in tree(p))}
a=Acp(home,fixed_env(home)); a.wait(a.send("initialize",INIT),120); a.wait(a.send("session/load",{"cwd":home,"sessionId":sid,"mcpServers":[]}),300)
out["acp_process_mb"]=rss(a.p.pid)
out["loaded_mb"]=rss(p); out["loaded_tree_mb"]=sum(rss(x) for x in tree(p)); out["children"]=len(tree(p))-1
time.sleep(60); out["loaded_plus60s_mb"]=rss(p)
a.close(); time.sleep(5); out["after_detach_mb"]=rss(p)
print(json.dumps(out)); os.kill(p,signal.SIGTERM); sp.wait(timeout=60)
