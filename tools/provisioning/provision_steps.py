"""The provisioning steps for provision-runner.py. Order and commands follow the PAR-5149 bring-up and docs/new-company.md.

Each step either completes or raises StepError; the first failure fails the request and leaves the company as it is (the message names
the step and, for the keys step, the --undo file). A step that needs a person raises NeedsOwner: the request ends as `needs_owner`. A failed or
needs_owner request that already made a company is resumed by the next request for the
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
    needs_owner = False

    def __init__(self, msg, **extra):
        super().__init__(msg)
        self.extra = extra


class NeedsOwner(StepError):
    """The request cannot go on until a person acts. The result is `needs_owner`, not `failed`; the same CRM company resumes it."""
    needs_owner = True


# a request that stopped on one of these is picked up by the next request for the same CRM company
RESUMABLE = ("failed", "needs_owner")
HIRE_TERMINAL = ("done", "cancelled")
HIRE_GRACE = 120
HIRE_POLL = 15
MIN_STAFFED = 2  # a resumed company with at least this many live agents already has its hires


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
    # Setup 0.6.3+ (PAR-5205): the host overwrites params.companyId with the page's company, and only the operator company's
    # page may set entitlements. So the action runs on PAR's page and names the new company in targetCompanyId. A module list
    # from the request means "entitle these"; the action wants a module -> state map.
    params = {"targetCompanyId": c.st["company_id"]}
    if c.req.get("plan"):
        params["plan"] = c.req["plan"]
    if c.req.get("modules"):
        params["modules"] = {m: "entitled" for m in c.req["modules"]}
    body = {"companyId": c.p["parCompanyId"], "params": params}
    out = c.api.post("/api/plugins/%s/actions/%s" % (c.p.get("setupPluginKey", "partnersinbiz.setup"), c.p.get("entitlementsAction", "setup.set-entitlements")), body)
    data = out.get("data", out) if isinstance(out, dict) else out
    if isinstance(data, dict) and (data.get("error") or data.get("ok") is False):
        raise StepError("setup.set-entitlements refused: %s" % redact(str(data.get("error") or data)[:300]))


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
    # Always the client profile, always named source: the runner never copies the PiB dev-team secrets.
    args = ["--profile", "client", "--from", c.p["parCompanyId"], "--to", c.st["prefix"], "--apply"]
    rc, out = c.script("copy-secrets", "copy-company-secrets.py", *args)
    if rc != 0:
        undo = re.findall(r"\S+\.undo\S*", out)
        raise StepError("copy-company-secrets.py failed (exit %d); stop here. Undo file: %s\n%s" % (rc, undo[-1] if undo else "(none named in the output)", tail(out)),
                        undo_file=undo[-1] if undo else None)


def _live_agents(c):
    return [a for a in c.api.get("/api/companies/%s/agents" % c.st["company_id"]) if str(a.get("status")).lower() != "terminated"]


def _hire_tasks(c):
    """The company's Setup hire tasks: plugin-origin issues whose title starts `Hire:`. Read-only."""
    q = "?originKindPrefix=plugin%3A&includePluginOperations=true&limit=200"
    rows = c.api.get("/api/companies/%s/issues%s" % (c.st["company_id"], q))
    if isinstance(rows, dict):
        rows = rows.get("items") or rows.get("issues") or []
    return [t for t in rows if str(t.get("originKind") or "").startswith("plugin:") and str(t.get("title") or "").startswith("Hire:")]


def _ids(tasks):
    return ", ".join("%s (%s)" % (t.get("identifier") or t.get("id"), t.get("status")) for t in tasks)


def step_hires(c):
    """Wait until every `Hire:` task of the new company is done or cancelled, then check the agents exist. Read-only: no
    comment, no wake. `--agents` is a capacity number only; it is not a wait count."""
    t0 = time.time()
    deadline = t0 + c.timeout("hires")
    last = None
    while True:
        tasks = _hire_tasks(c)
        agents = _live_agents(c)
        c.st["agents"] = [{"id": a["id"], "name": a.get("name"), "role": a.get("role"), "title": a.get("title")} for a in agents]
        open_ = [t for t in tasks if str(t.get("status")).lower() not in HIRE_TERMINAL]
        if tasks and not open_:
            now = sorted(t.get("id") or t.get("identifier") or "" for t in tasks)
            if now == last:  # two polls in a row with the same, all-terminal set
                break
            last = now
        else:
            last = None
            if not tasks and time.time() - t0 >= HIRE_GRACE:
                if c.st.get("resumed") and len(agents) >= MIN_STAFFED:
                    c.st["note_hires"] = "no hire tasks found; the company already has %d agents (already staffed)" % len(agents)
                    return
                raise StepError("no hire tasks found in the new company after %d s" % HIRE_GRACE)
        if time.time() > deadline:
            if tasks and not open_:
                break  # all finished, the second confirming poll just ran out of time
            stuck = [t for t in open_ if str(t.get("status")).lower() == "blocked"]
            if stuck and len(stuck) == len(open_):
                raise NeedsOwner("hire task(s) still blocked after %d s, so a person must act: %s" % (c.timeout("hires"), _ids(stuck)))
            if open_:
                raise StepError("hire tasks not finished after %d s: %s" % (c.timeout("hires"), _ids(open_)))
            raise StepError("no hire tasks found in the new company after %d s" % c.timeout("hires"))
        c.sleep(HIRE_POLL)
    done = [t for t in tasks if str(t.get("status")).lower() == "done"]
    if len(agents) < len(done):
        raise StepError("%d hire tasks are done but the company has only %d live agents" % (len(done), len(agents)))


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
            with open(os.path.join(d, n)) as fh:
                r = json.load(fh)
        except (OSError, ValueError):
            continue
        if r.get("id") != rid and r.get("status") in RESUMABLE and r.get("crm_company_id") == req["crm_company_id"] and r.get("company_id"):
            best = r
    return best


def run(runner, rid, req):
    prior = prior_failed(runner, req, rid)
    st = {"steps_done": [], "company_id": None, "prefix": None}
    if prior:
        st.update({k: prior.get(k) for k in ("company_id", "prefix")})
        st["steps_done"] = [s for s in prior.get("steps_done", []) if s != prior.get("step")]
        st["resumed"] = True
    for name, fn in STEPS:
        if name in st["steps_done"]:
            continue
        keep = lambda: {k: st.get(k) for k in ("company_id", "prefix", "steps_done")}  # noqa: E731
        runner.save_result(rid, req, "running", "step: " + name, step=name, **keep())
        try:
            fn(Ctx(runner, rid, req, st))
        except NeedsOwner as e:
            raise NeedsOwner("step %s needs the owner: %s. File the same request again once it is done; it resumes this company." % (name, e),
                             step=name, **{**keep(), **e.extra})
        except StepError as e:
            raise StepError("step %s failed: %s" % (name, e), step=name, **{**keep(), **e.extra})
        except RuntimeError as e:  # an API call failed
            raise StepError("step %s failed: %s" % (name, redact(str(e))), step=name, **keep())
        st["steps_done"].append(name)
    url = (runner.policy.get("ownerListUrlTemplate") or "").replace("{prefix}", st["prefix"]).replace("{companyId}", st["company_id"])
    msg = "Company %s (%s) is provisioned and `new-company.py --verify` passed." % (req["name"], st["prefix"])
    for k in ("note_entitlements", "note_hires", "note_model_key"):
        if st.get(k):
            msg += "\n- " + st[k]
    if not url:
        msg += "\n- No ownerListUrlTemplate in the policy, so there is no owner list link yet."
    return {"message": msg, "company_id": st["company_id"], "prefix": st["prefix"], "steps_done": st["steps_done"], "owner_list_url": url or None}
