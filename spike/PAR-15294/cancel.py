# Throwaway spike (PAR-15294): send ACP session/cancel during a long reply, record timing and store state.
import sys, time, json, sqlite3
sys.path.insert(0, __file__.rsplit("/",1)[0]); from acpc import *
home, n, delay = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
a=Acp(home); a.wait(a.send("initialize",INIT),120)
for i in range(n):
    r=a.wait(a.send("session/new",{"cwd":home,"mcpServers":[]}),300); sid=r["result"]["sessionId"]
    chunks=[]; st={"cancel_t":None}
    def on(m):
        if m and m.get("method")=="session/update":
            u=m["params"]["update"]; k=u.get("sessionUpdate")
            c=u.get("content")
            txt=c.get("text","") if isinstance(c,dict) else ""
            chunks.append((m["_t"],k,len(txt)))
        if st["cancel_t"] is None and time.time()-tp>=delay:
            st["cancel_t"]=time.time(); a.send("session/cancel",{"sessionId":sid},note=True)
    tp=time.time()
    rid=a.send("session/prompt",{"sessionId":sid,"prompt":[{"type":"text","text":"Write a 1,500-word essay on the history of the bicycle. No tools, no preamble, just the essay."}]})
    pr=a.wait(rid,300,on_msg=on); te=time.time()
    ct=st["cancel_t"]
    msgchunks=[c for c in chunks if c[1]=="agent_message_chunk"]
    out={"try":i+1,"cancel_sent_after_s":round(ct-tp,2) if ct else None,"prompt_end_after_prompt_s":round(te-tp,2),
         "cancel_to_prompt_end_s":round(te-ct,2) if ct else None,"stopReason":(pr.get("result") or {}).get("stopReason"),"err":pr.get("error"),
         "msg_chunks":len(msgchunks),"chars_streamed":sum(c[2] for c in msgchunks),"chunks_before_cancel":sum(1 for c in msgchunks if ct and c[0]<ct),
         "update_kinds":sorted({c[1] for c in chunks}),"sid":sid}
    time.sleep(1.5)
    db=sqlite3.connect("file:"+home+"/state.db?mode=ro",uri=True)
    rows=db.execute("select role,length(content),finish_reason from messages where session_id=? order by id",(sid,)).fetchall()
    out["store_msgs"]=[(r[0],r[1],r[2]) for r in rows]
    print(json.dumps(out),flush=True)
a.close()
