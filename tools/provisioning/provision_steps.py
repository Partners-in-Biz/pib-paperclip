"""The provisioning steps for provision-runner.py. Order and commands follow the PAR-5149 bring-up and docs/new-company.md.

Each step either completes or raises StepError; the first failure fails the request and leaves the company as it is (the message names
the step and, for the keys step, the --undo file). A failed request that already made a company is resumed by the next request for the
same CRM company: finished steps are skipped. The runner only reads state after the hires start: it never comments on, reopens or
touches a hire task (that wakes the CEO).
"""
import json
import os
import re
import subprocess
import time

DEFAULT_TIMEOUTS = {"create-ceo": 300, "setup-run": 300, "copy-secrets": 300, "hires": 900, "apply": 300, "model-key": 300, "verify": 300}
SECRET_RE = re.compile(r"(sk-ant-[A-Za-z0-9_-]+|Bearer\s+\S+|[A-Fa-f0-9]{40,}|pcp_[A-Za-z0-9_-]{16,})")


class StepError(Exception):
    def __init__(self, msg, **extra):
        super().__init__(msg)
        self.extra = extra


def redact(text):
    return SECRET_RE.sub("[redacted]", text or "")


def tail(text, n=6):
    return "\n".join(redact(text).strip().splitlines()[-n:])


def exec_cmd(argv, timeout, env=None):
    """Run a server command; (exit code, combined output). Tests replace this."""
    e = dict(os.environ)
    e.update(env or {})
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=e)
    except subprocess.TimeoutExpired:
        return 124, "timed out after %ds" % timeout
    except OSError as ex:
        return 127, "could not run %s: %s" % (argv[0], ex.strerror)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


class Ctx:
    def __init__(self, runner, rid, req, st):
        self.runner, self.rid, self.req, self.st = runner, rid, req, st
        self.p, self.api = runner.policy, runner.api
        self.ops = self.p.get("opsDir", "/root/pib-ops")
        self.sleep = time.sleep

    def timeout(self, step):
        return (self.p.get("stepTimeouts") or {}).get(step, DEFAULT_TIMEOUTS[step])

    def script(self, step, name, *args, env=None):
        rc, out = exec_cmd(["python3", os.path.join(self.ops, name)] + list(args), self.timeout(step), env)
        return rc, out

    def must(self, step, name, *args, env=None):
        rc, out = self.script(step, name, *args, env=env)
        if rc != 0:
            raise StepError("%s %s failed (exit %d):\n%s" % (name, " ".join(args[:2]), rc, tail(out)), output=tail(out))
        return out


# --- steps ---
def step_create_company(c):
    if c.st.get("company_id"):
        return
    made = c.api.post("/api/companies", {"name": c.req["name"]})
    cid = (made or {}).get("id")
    if not cid:
        raise StepError("Paperclip did not return a company id")
    c.st["company_id"] = cid  # recorded at once so a later failure never orphans it
    back = c.api.get("/api/companies/" + cid)  # read back: the host picked the prefix
    if back.get("name") != c.req["name"] or not back.get("issuePrefix"):
        raise StepError("the created company did not read back with its name and issue prefix")
    if not re.match(r"^[A-Z0-9]{2,10}$", str(back["issuePrefix"])):
        raise StepError("the host returned an issue prefix that is not safe to pass to the server scripts")
    c.st["prefix"] = back["issuePrefix"]


def step_entitlements(c):
    if not c.req.get("plan") and not c.req.get("modules"):
        c.st["note_entitlements"] = "no plan or modules requested; entitlements left at the defaults"
        return
    body = {"companyId": c.st["company_id"], "params": {"companyId": c.st["company_id"], "plan": c.req.get("plan"),
                                                       "modules": c.req.get("modules") or []}}
    out = c.api.post("/api/plugins/%s/actions/%s" % (c.p.get("setupPluginKey", "partnersinbiz.setup"), c.p.get("entitlementsAction", "set-entitlements")), body)
    if isinstance(out, dict) and (out.get("error") or out.get("ok") is False):
        raise StepError("setup.set-entitlements refused: %s" % redact(str(out.get("error") or out)[:300]))


def step_create_ceo(c):
    c.must("create-ceo", "new-company.py", "--company", c.st["prefix"], "--create-ceo", "--apply")


def step_setup_run(c):
    """The Setup New company run headless (bootstrap-runner + bootstrap-client bundle, board token). The profile is a parameter."""
    profile = c.req["profile"]  # profile client is refused at intake until setupProfileWired (PAR-5157)
    cmd = c.p.get("setupRunnerCommand")
    if not cmd:
        raise StepError("the policy has no setupRunnerCommand (the headless Setup runner bundle)")
    argv = [a.replace("{companyId}", c.st["company_id"]).replace("{prefix}", c.st["prefix"]).replace("{profile}", profile) for a in cmd]
    rc, out = exec_cmd(argv, c.timeout("setup-run"), {"PIB_BOARD_TOKEN": c.api._board})
    if rc != 0:
        raise StepError("the headless Setup runner failed (exit %d):\n%s" % (rc, tail(out)))


def step_copy_secrets(c):
    args = ["--to", c.st["prefix"], "--apply"]
    if c.req["profile"] == "client":
        args = ["--profile", "client"] + args
    rc, out = c.script("copy-secrets", "copy-company-secrets.py", *args)
    if rc != 0:
        undo = re.findall(r"\S+\.undo\S*", out)
        raise StepError("copy-company-secrets.py failed (exit %d); stop here. Undo file: %s\n%s" % (rc, undo[-1] if undo else "(none named in the output)", tail(out)),
                        undo_file=undo[-1] if undo else None)


def step_hires(c):
    """Wait until the CEO has hired. Read-only: no comment, no wake."""
    want = int(c.req.get("agents") or c.p["agentsPerNewCompany"])  # the CEO counts
    deadline = time.time() + c.timeout("hires")
    while True:
        agents = [a for a in c.api.get("/api/companies/%s/agents" % c.st["company_id"]) if str(a.get("status")).lower() != "terminated"]
        c.st["agents"] = [{"id": a["id"], "name": a.get("name"), "role": a.get("role"), "title": a.get("title")} for a in agents]
        if len(agents) >= want:
            return
        if time.time() > deadline:
            raise StepError("the CEO has hired %d of %d agents after %d s; not touching the hire tasks" % (len(agents), want, c.timeout("hires")))
        c.sleep(15)


def step_link_agents(c):
    for rule in c.p.get("linkAgents") or []:
        for a in c.st.get("agents", []):
            who = " ".join(str(a.get(k) or "") for k in ("role", "title", "name")).lower()
            if rule["roleMatch"].lower() in who:
                out = c.api.post("/api/plugins/%s/actions/%s" % (rule["plugin"], rule.get("action", "link-agent")),
                                 {"companyId": c.st["company_id"], "params": {"agentId": a["id"], "companyId": c.st["company_id"]}})
                if isinstance(out, dict) and (out.get("error") or out.get("ok") is False):
                    raise StepError("%s link-agent for %s refused: %s" % (rule["plugin"], a.get("name"), redact(str(out.get("error") or out)[:200])))


def step_apply(c):
    # attaches each recognised hired agent's role skills (an Operator without its identity skill is skipped by the script)
    c.must("apply", "new-company.py", "--company", c.st["prefix"], "--apply")


def step_model_key(c):
    if not c.req.get("model_key"):
        c.st["note_model_key"] = "no model key supplied; the company runs on the instance login"
        return
    c.must("model-key", "new-company.py", "--company", c.st["prefix"], "--model-key-bind", "--apply")


def step_verify(c):
    rc, out = c.script("verify", "new-company.py", "--company", c.st["prefix"], "--verify")
    bad = [ln for ln in out.splitlines() if re.search(r"\b(WARN|FAIL)\b", ln)]
    if rc != 0 or bad:
        raise StepError("new-company.py --verify did not pass (exit %d):\n%s" % (rc, redact("\n".join(bad[:8]) or tail(out))))


def step_crm_record(c):
    ctx = {"agentId": c.req["requester"]["id"], "runId": c.req.get("run_id") or c.rid, "companyId": c.p["parCompanyId"], "projectId": c.p.get("crmProjectId")}
    if not ctx["projectId"]:
        raise StepError("the policy has no crmProjectId, so hosted_company_id could not be written on the CRM record")

    def tool(name, params):
        return c.api.post("/api/plugins/tools/execute", {"tool": name, "parameters": params, "runContext": ctx})
    try:
        tool("crm:define-field", {"recordType": "company", "fieldKey": "hosted_company_id", "label": "Hosted company id"})
    except RuntimeError:
        pass  # already defined
    tool("crm:update-company", {"companyRecordId": c.req["crm_company_id"], "custom": {"hosted_company_id": c.st["company_id"]}})
    back = tool("crm:get-company", {"companyRecordId": c.req["crm_company_id"]})
    if c.st["company_id"] not in json.dumps(back):
        raise StepError("hosted_company_id did not read back on CRM company %s" % c.req["crm_company_id"])


STEPS = [("create-company", step_create_company), ("entitlements", step_entitlements), ("create-ceo", step_create_ceo),
         ("setup-run", step_setup_run), ("copy-secrets", step_copy_secrets), ("hires", step_hires), ("link-agents", step_link_agents),
         ("apply", step_apply), ("model-key", step_model_key), ("verify", step_verify), ("crm-record", step_crm_record)]


def prior_failed(runner, req, rid):
    d = os.path.join(runner.spool, "results")
    best = None
    for n in sorted(os.listdir(d)):
        try:
            r = json.load(open(os.path.join(d, n)))
        except (OSError, ValueError):
            continue
        if r.get("id") != rid and r.get("status") == "failed" and r.get("crm_company_id") == req["crm_company_id"] and r.get("company_id"):
            best = r
    return best


def run(runner, rid, req):
    prior = prior_failed(runner, req, rid)
    st = {"steps_done": [], "company_id": None, "prefix": None}
    if prior:
        st.update({k: prior.get(k) for k in ("company_id", "prefix")})
        st["steps_done"] = [s for s in prior.get("steps_done", []) if s != prior.get("step")]
    for name, fn in STEPS:
        if name in st["steps_done"]:
            continue
        keep = lambda: {k: st.get(k) for k in ("company_id", "prefix", "steps_done")}  # noqa: E731
        runner.save_result(rid, req, "running", "step: " + name, step=name, **keep())
        try:
            fn(Ctx(runner, rid, req, st))
        except StepError as e:
            raise StepError("step %s failed: %s" % (name, e), step=name, **{**keep(), **e.extra})
        except RuntimeError as e:  # an API call failed
            raise StepError("step %s failed: %s" % (name, redact(str(e))), step=name, **keep())
        st["steps_done"].append(name)
    url = (runner.policy.get("ownerListUrlTemplate") or "").replace("{prefix}", st["prefix"]).replace("{companyId}", st["company_id"])
    msg = "Company %s (%s) is provisioned and `new-company.py --verify` passed." % (req["name"], st["prefix"])
    for k in ("note_entitlements", "note_model_key"):
        if st.get(k):
            msg += "\n- " + st[k]
    if not url:
        msg += "\n- No ownerListUrlTemplate in the policy, so there is no owner list link yet."
    return {"message": msg, "company_id": st["company_id"], "prefix": st["prefix"], "steps_done": st["steps_done"], "owner_list_url": url or None}
