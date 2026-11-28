# Build scratch state.db holding a COPY of one session (read-only source).
import sys, sqlite3, os
sys.path.insert(0, os.path.expanduser("~/.hermes/hermes-agent"))
hh, src, sid = sys.argv[1:4]
os.environ["HERMES_HOME"] = hh
from hermes_state import SessionDB
db = SessionDB(__import__("pathlib").Path(hh)/"state.db"); db.close() if hasattr(db,"close") else None
c = sqlite3.connect(os.path.join(hh, "state.db"))
c.execute("attach database ? as src", (f"file:{src}?mode=ro",)) if False else None
c.close()
c = sqlite3.connect(f"file:{os.path.join(hh,'state.db')}", uri=True)
c.execute("attach database ? as src", (f"file:{src}?mode=ro",))
def cols(t): return [r[1] for r in c.execute(f"pragma main.table_info({t})")]
def scols(t): return {r[1] for r in c.execute(f"pragma src.table_info({t})")}
for t, key in (("sessions","id"),("messages","session_id")):
    cc = [x for x in cols(t) if x in scols(t)]
    l = ",".join(cc)
    c.execute(f"insert or ignore into main.{t}({l}) select {l} from src.{t} where {key}=?", (sid,))
# system prompt dedupe table
try:
    c.execute("insert or ignore into main.system_prompts select * from src.system_prompts where hash in (select system_prompt_hash from main.sessions)")
except Exception as e: print("sysprompts:", e)
c.commit()
print(list(c.execute("select message_count,input_tokens,output_tokens,model from main.sessions")), list(c.execute("select count(*),sum(coalesce(token_count,0)),sum(length(content)) from main.messages")))
