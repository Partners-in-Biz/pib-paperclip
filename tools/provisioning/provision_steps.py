"""The provisioning steps for provision-runner.py. Order and commands follow the PAR-5149 bring-up and docs/new-company.md.

Each step either completes or raises StepError; the first failure fails the request and leaves the company as it is (the message names
the step and, for the keys step, the --undo file). A step that needs a person raises NeedsOwner: the request ends as `needs_owner`. A failed or
needs_owner request that already made a company is resumed by the next request for the
same CRM company: finished steps are skipped. The runner only reads state until the hire-skills step (after apply); only that step touches a hire task, to attach skills, accept
the skills card and close it (that wakes the CEO, which is intended).
"""
import json
import os
import re
import subprocess
import time

DEFAULT_TIMEOUTS = {"create-ceo": 300, "setup-run": 300, "copy-secrets": 300, "hires": 900, "apply": 300, "hire-skills": 120, "model-key": 300, "verify": 300}
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
HIRE_PARKED = ("in_review", "blocked")  # the CEO cannot attach skills itself (403 agents:configure): its task waits on the runner's hire-skills step
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


KEY_SECRET = "ANTHROPIC_API_KEY"


def _require_key_secret(c):
    """The new company must hold an active secret named ANTHROPIC_API_KEY. Reads the catalog (id, name, key, status), never a value.
    An HTTP error is a failure (the RuntimeError from the API helper carries the status code), never a pass and never `needs_owner`."""
    rows = c.api.get("/api/companies/%s/secrets/catalog" % c.st["company_id"])
    if isinstance(rows, dict):
        rows = rows.get("items") or rows.get("secrets") or []
    mine = [r for r in rows if isinstance(r, dict) and r.get("name") == KEY_SECRET]
    if any(str(r.get("status")).lower() == "active" for r in mine):
        return
    why = "its status is %s" % ", ".join(sorted({str(r.get("status")) for r in mine})) if mine else "it does not exist"
    raise NeedsOwner("owner: add secret %s on the Secrets page of %s (Setup, Model key step); %s" % (KEY_SECRET, c.st["prefix"], why))


def step_key_gate(c):
    """Before the first agent exists: a client company must have its own model key, or its agents would run on the host login."""
    if not c.req.get("model_key"):
        c.st["note_key_gate"] = "no model key supplied; the key gate was skipped"
        return
    _require_key_secret(c)
    c.st["note_key_gate"] = "key gate: the secrets catalog answered 2xx and holds an active %s" % KEY_SECRET


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


def _hire_name(task):
    m = re.match(r"\s*Hire:\s*(.+?)\s*(\(.*\))?\s*$", str(task.get("title") or ""))
    return m.group(1).strip().lower() if m else ""


def _hired_agent(task, agents):
    """The live agent a `Hire:` task names (its role, title or name equals the task's name part), or None."""
    want = _hire_name(task)
    if not want:
        return None
    for a in agents:
        if want in (str(a.get(k) or "").strip().lower() for k in ("name", "title", "role")):
            return a
    return None


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
        # a parked task whose agent exists counts as hired: only the runner's hire-skills step can finish it
        open_ = [t for t in tasks if str(t.get("status")).lower() not in HIRE_TERMINAL
                 and not (str(t.get("status")).lower() in HIRE_PARKED and _hired_agent(t, agents))]
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
    done = [t for t in tasks if str(t.get("status")).lower() not in ("cancelled",)]
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


SKILL_RE = re.compile(r"^\s*-\s*`([^`]+)`\s*$")


def _task_skills(description):
    """The skill keys under `## Skills to attach` in a hire task's description."""
    out, on = [], False
    for ln in str(description or "").splitlines():
        if ln.startswith("## "):
            on = ln.strip().lower() == "## skills to attach"
        elif on:
            m = SKILL_RE.match(ln)
            if m:
                out.append(m.group(1))
    return out


def step_hire_skills(c):
    """The CEO cannot attach skills (403 agents:configure), so its hire task sits `in_review` with an owner card. Here, after link-agents
    and apply, the board token attaches the skills the task names (add mode), accepts the open cards and closes the task. The accept wakes
    the CEO, which is intended: it closes its own task. A task with no matching agent is left alone (the hires step already decided)."""
    agents = _live_agents(c)
    left = []
    for t in _hire_tasks(c):
        if str(t.get("status")).lower() not in HIRE_PARKED:
            continue
        agent = _hired_agent(t, agents)
        if not agent:
            left.append(t)
            continue
        tid = t["id"]
        desc = t.get("description")
        if desc is None:
            desc = (c.api.get("/api/issues/%s" % tid) or {}).get("description")
        skills = _task_skills(desc)
        if skills:
            c.api.post("/api/agents/%s/skills/sync" % agent["id"], {"mode": "add", "desiredSkills": skills})
        cards = c.api.get("/api/issues/%s/interactions" % tid)
        if isinstance(cards, dict):
            cards = cards.get("items") or cards.get("interactions") or []
        for card in cards or []:
            if isinstance(card, dict) and str(card.get("status")).lower() == "pending" and card.get("kind") != "connection_intent":
                c.api.post("/api/issues/%s/interactions/%s/accept" % (tid, card["id"]), {})
        c.api.patch("/api/issues/%s" % tid, {"status": "done", "comment": "Provisioning runner: attached %s to %s and accepted the skills card. Closing this hire."
                                             % (", ".join(skills) or "no skills", agent.get("name") or agent["id"])})
    if left:
        raise StepError("hire task(s) with no matching agent: %s" % _ids(left))


def step_model_key(c):
    if not c.req.get("model_key"):
        c.st["note_model_key"] = "no model key supplied; the company runs on the instance login"
        return
    _require_key_secret(c)  # the secret may have gone since the gate; bind nothing without it
    c.must("model-key", "new-company.py", "--company", c.st["prefix"], "--model-key-bind", "--apply")
    # read-back: the first claude_local agent must carry env.ANTHROPIC_API_KEY as a secret reference. Only the shape is checked, never a value.
    agents = [a for a in c.api.get("/api/companies/%s/agents" % c.st["company_id"])
              if str(a.get("status")).lower() != "terminated" and a.get("adapterType") == "claude_local"]
    if not agents:
        raise StepError("model key read-back: the company has no claude_local agent")
    env = (agents[0].get("adapterConfig") or {}).get("env") or {}
    bound = env.get(KEY_SECRET)
    if not (isinstance(bound, dict) and bound.get("type") == "secret_ref"):
        raise StepError("model key read-back: agent %s has no env.%s secret_ref" % (agents[0].get("name") or agents[0].get("id"), KEY_SECRET))


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
    # Plugin tools are registered under the plugin key (partnersinbiz.crm:<tool>), and CRM 0.31 (PAR-5160) has a first-class
    # hostedCompanyId on a company record, so no custom field is defined (live proof PAR-5235, 2026-10-24).
    upd = tool("partnersinbiz.crm:update-company", {"companyRecordId": c.req["crm_company_id"], "hostedCompanyId": c.st["company_id"]})
    back = tool("partnersinbiz.crm:get-company", {"companyRecordId": c.req["crm_company_id"]})
    # update-company answers with the record and its hosted fields; get-company's client summary may leave them out.
    if c.st["company_id"] not in json.dumps(upd) and c.st["company_id"] not in json.dumps(back):
        raise StepError("hosted_company_id did not read back on CRM company %s" % c.req["crm_company_id"])


INVITE_BODY = {"allowedJoinTypes": "human", "humanRole": "owner"}  # the only body ever sent: owner of this company, never instance admin


def _invite_rows(c, state):
    rows = c.api.get("/api/companies/%s/invites?state=%s&limit=100" % (c.st["company_id"], state))
    if isinstance(rows, dict):
        rows = rows.get("items") or rows.get("invites") or []
    return [r for r in rows if isinstance(r, dict)]


def step_owner_invite(c):
    """The client's first person gets a human invite with role owner (host patch 12: sign-up stays closed except through a valid invite).
    The invite link is a credential and the host returns its token once, so the link goes to the result comment only: never to the
    result file, a log line or an error text. The invite id is saved the moment the host answers, so a resumed request never makes a second one."""
    old = c.st.get("invite_id")
    if old:
        if any(r.get("id") == old for r in _invite_rows(c, "accepted")):
            c.st["note_invite"] = "owner invite %s was already accepted; no second invite was made" % old
            return
        if any(r.get("id") == old for r in _invite_rows(c, "active")):
            raise NeedsOwner("owner invite %s exists but its link was not kept (the host shows it once). Revoke it on the Members page of %s, then file the same request again; "
                             "a fresh invite is made" % (old, c.st["prefix"]))
        c.st["invite_id"] = None  # revoked or expired: safe to make a new one
    made = c.api.post("/api/companies/%s/invites" % c.st["company_id"], dict(INVITE_BODY))
    iid = (made or {}).get("id")
    if not iid:
        raise StepError("Paperclip did not return an invite id")
    c.st["invite_id"] = iid
    c.runner.save_result(c.rid, c.req, "running", "step: owner-invite", step="owner-invite", company_id=c.st["company_id"], prefix=c.st["prefix"],
                         steps_done=list(c.st["steps_done"]), invite_id=iid)  # recorded at once: a crash after this resumes without a duplicate
    url = made.get("inviteUrl")
    if not url:
        raise StepError("Paperclip returned invite %s without an inviteUrl; revoke it on the Members page and file again" % iid)
    c.st["invite_url"] = url  # memory only; see run() and Runner.comment
    c.st["note_invite"] = "owner invite %s created (role owner, human); the link is in the comment below, it is single use" % iid


STEPS = [("create-company", step_create_company), ("entitlements", step_entitlements), ("key-gate", step_key_gate), ("create-ceo", step_create_ceo),
         ("setup-run", step_setup_run), ("copy-secrets", step_copy_secrets), ("hires", step_hires), ("link-agents", step_link_agents),
         ("apply", step_apply), ("hire-skills", step_hire_skills), ("model-key", step_model_key), ("verify", step_verify), ("crm-record", step_crm_record),
         ("owner-invite", step_owner_invite)]


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
        st.update({k: prior.get(k) for k in ("company_id", "prefix", "invite_id")})
        st["steps_done"] = [s for s in prior.get("steps_done", []) if s != prior.get("step")]
        st["resumed"] = True
    for name, fn in STEPS:
        if name in st["steps_done"]:
            continue
        keep = lambda: {k: st.get(k) for k in ("company_id", "prefix", "steps_done", "invite_id")}  # noqa: E731
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
    for k in ("note_entitlements", "note_key_gate", "note_hires", "note_model_key", "note_invite"):
        if st.get(k):
            msg += "\n- " + st[k]
    if not url:
        msg += "\n- No ownerListUrlTemplate in the policy, so there is no owner list link yet."
    # invite_url is a credential: Runner.finish takes it out before the result file is written and only the comment shows it
    return {"message": msg, "company_id": st["company_id"], "prefix": st["prefix"], "steps_done": st["steps_done"], "owner_list_url": url or None,
            "invite_id": st.get("invite_id"), "invite_url": st.get("invite_url")}
