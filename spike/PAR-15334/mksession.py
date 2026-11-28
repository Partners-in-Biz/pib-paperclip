# Make a session in scratch home via ACP, then copy messages of a real session (read-only src) into it.
import sys, sqlite3, json, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from acpc import *; from env import fixed_env
home, src, ssid = sys.argv[1:4]; mult = int(sys.argv[4]) if len(sys.argv)>4 else 1
if len(sys.argv)>5: sid=sys.argv[5]
else:
    a=Acp(home, fixed_env(home)); a.wait(a.send("initialize",INIT),120)
    r=a.wait(a.send("session/new",{"cwd":home,"mcpServers":[]}),120); sid=r["result"]["sessionId"]; print("sid",sid)
    a.close()
c=sqlite3.connect("file:"+os.path.join(home,"state.db"),uri=True,timeout=60); c.execute("attach database ? as src",(f"file:{src}?mode=ro",))
def cols(t): return [r[1] for r in c.execute(f"pragma main.table_info({t})")]
sc={r[1] for r in c.execute("pragma src.table_info(messages)")}
cc=[x for x in cols("messages") if x in sc and x not in("id","session_id")]
l=",".join(cc)
for m in range(mult):
    c.execute(f"insert into main.messages(session_id,{l}) select ?,{l} from src.messages where session_id=? order by id",(sid,ssid))
c.commit()
print(list(c.execute("select count(*),sum(length(content)) from main.messages where session_id=?",(sid,))))
