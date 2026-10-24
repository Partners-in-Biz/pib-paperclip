#!/usr/bin/env python3
"""provision-runner: the root service behind pib-provision-request (same pattern as deploy-runner.py).

Installed by Peet's Cowork session into pib-ops. Triggered by pib-provision-runner.path when a file lands in <spool>/incoming.
Agents can write into incoming/ but not list it; results/ is world-readable and never holds a token.

Per request file: prove who asked (the run's token against GET /api/agents/me, then drop the token), check the policy (kill switch,
requester role, issue ownership, one open request per CRM company, capacity gate), then run the steps (provision_steps.py).
Every file write is read back. Nothing here prints or stores a token or a key.
"""
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SPOOL = os.environ.get("PIB_PR_SPOOL", "/var/spool/pib-provision")
POLICY = os.environ.get("PIB_PR_POLICY", os.path.join(HERE, "provision-policy.json"))
OPEN = ("queued", "running")
ID_RE = re.compile(r"^p-\d{8}-\d{6}-[0-9a-f]{6}$")


class Refused(Exception):
    pass


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Api:
    """Paperclip HTTP API. `agent_get` uses the requester's token, everything else the board token."""

    def __init__(self, base, board_token):
        self.base, self._board = base.rstrip("/"), board_token

    def _call(self, method, path, token, body=None, timeout=30):
        data = None if body is None else json.dumps(body).encode()
        rq = urllib.request.Request(self.base + path, data=data, method=method)
        rq.add_header("Authorization", "Bearer " + token)
        if data is not None:
            rq.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(rq, timeout=timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError("%s %s -> HTTP %d" % (method, path, e.code))
        except (urllib.error.URLError, OSError) as e:
            raise RuntimeError("%s %s -> %s" % (method, path, getattr(e, "reason", e)))
        return json.loads(raw) if raw else None

    def agent_get(self, path, token):
        return self._call("GET", path, token)

    def get(self, path):
        return self._call("GET", path, self._board)

    def post(self, path, body, timeout=60):
        return self._call("POST", path, self._board, body, timeout)

    def patch(self, path, body):
        return self._call("PATCH", path, self._board, body)


def write_json(path, obj, mode=0o644):
    """Atomic write, then read back and compare."""
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.rename(tmp, path)
    with open(path) as fh:
        if json.load(fh) != json.loads(json.dumps(obj)):
            raise RuntimeError("read-back of %s differs from what was written" % path)


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def load_policy(path=POLICY):
    p = load_json(path)
    if not isinstance(p, dict):
        raise Refused("the policy file %s is missing or not valid JSON" % path)
    for k in ("maxHostedCompanies", "maxAgentsTotal", "agentsPerNewCompany"):
        if not isinstance(p.get(k), int) or isinstance(p.get(k), bool) or p[k] < 1:
            raise Refused("the policy needs %s as a positive whole number" % k)
    for k in ("parCompanyId", "apiBase", "allowedRequesters", "profiles"):
        if not p.get(k):
            raise Refused("the policy needs %s" % k)
    return p


class Runner:
    def __init__(self, policy, api, spool=SPOOL, steps=None):
        self.policy, self.api, self.spool, self.steps = policy, api, spool, steps
        for d in ("incoming", "results", "work"):
            os.makedirs(os.path.join(spool, d), exist_ok=True)

    def path(self, *parts):
        return os.path.join(self.spool, *parts)

    # --- results ---
    def result(self, rid):
        return load_json(self.path("results", rid + ".json"))

    def save_result(self, rid, req, status, message="", **extra):
        r = {"id": rid, "status": status, "message": message, "updated": now(), "name": req.get("name"), "issue": req.get("issue"),
             "crm_company_id": req.get("crm_company_id"), "profile": req.get("profile")}
        r.update(extra)
        write_json(self.path("results", rid + ".json"), r)
        return r

    # --- intake checks ---
    def kill_switch(self):
        if self.policy.get("enabled") is not True:
            raise Refused("refused: provisioning is switched off in the policy (enabled is not true)")
        if os.path.exists(self.path("DISABLED")):
            raise Refused("refused: provisioning is switched off (the DISABLED file exists in the spool)")

    def prove_identity(self, token):
        if not token:
            raise Refused("refused: the request carries no token, so the runner cannot tell who you are. Run it from an agent run")
        try:
            me = self.api.agent_get("/api/agents/me", token)
        except RuntimeError:
            raise Refused("refused: Paperclip did not accept the run's token (expired, or not an agent key)")
        if not isinstance(me, dict) or not me.get("id"):
            raise Refused("refused: /api/agents/me returned no agent")
        if me.get("companyId") != self.policy["parCompanyId"]:
            raise Refused("refused: only agents of the PAR company may request a company")
        if str(me.get("status") or "").lower() in ("terminated", "paused"):
            raise Refused("refused: the requesting agent is %s" % me.get("status"))
        who = " ".join(str(me.get(k) or "") for k in ("role", "title", "name")).lower()
        if not any(a.lower() in who for a in self.policy["allowedRequesters"]):
            raise Refused("refused: only %s may request a company" % " or ".join(self.policy["allowedRequesters"]))
        return me

    def check_issue(self, req, me):
        ref = req.get("issue")
        if not ref or not re.match(r"^[A-Z]{2,6}-\d{1,6}$", ref):
            raise Refused("refused: --issue is required and must look like PAR-123")
        try:
            iss = self.api.get("/api/issues/" + ref)
        except RuntimeError:
            raise Refused("refused: issue %s was not found" % ref)
        if iss.get("companyId") != self.policy["parCompanyId"]:
            raise Refused("refused: issue %s is not in the PAR company" % ref)
        if self.policy.get("requireIssueAssignee", True) and iss.get("assigneeAgentId") != me["id"]:
            raise Refused("refused: you are not the assignee of %s" % ref)
        return iss

    def check_request(self, req):
        if req.get("kind") != "company":
            raise Refused("refused: unknown request kind")
        name = (req.get("name") or "").strip()
        if not name or len(name) > 80:
            raise Refused("refused: the company name must be 1 to 80 characters")
        if req.get("profile") not in self.policy["profiles"]:
            raise Refused("refused: profile must be one of %s" % ", ".join(self.policy["profiles"]))
        if not re.match(r"^[A-Za-z0-9_-]{4,64}$", req.get("crm_company_id") or ""):
            raise Refused("refused: crm_company_id is missing or malformed")
        if req["profile"] == "client" and not req.get("model_key"):
            raise Refused("refused: a client company needs the client's own model key (task 2.2); file again with --model-key once it is supplied")
        n = req.get("agents")
        if n is not None and (not isinstance(n, int) or isinstance(n, bool) or n < 1 or n > self.policy.get("maxAgentsPerRequest", 10)):
            raise Refused("refused: agents must be a whole number from 1 to %d" % self.policy.get("maxAgentsPerRequest", 10))

    def check_open_and_done(self, req):
        d = self.path("results")
        for n in os.listdir(d):
            r = load_json(os.path.join(d, n)) if n.endswith(".json") else None
            if not r or r.get("id") == req["id"] or r.get("crm_company_id") != req["crm_company_id"]:
                continue
            if r.get("status") in OPEN:
                raise Refused("refused: request %s for this company is still open (%s)" % (r["id"], r["status"]))
            if r.get("status") == "done":
                raise Refused("refused: this CRM company is already provisioned by request %s (company %s)" % (r["id"], r.get("company_id")))

    def capacity(self, req):
        """The gate. Counts the whole box (PAR included): companies not archived, agents not terminated."""
        p = self.policy
        companies = [c for c in self.api.get("/api/companies") if str(c.get("status") or "").lower() != "archived"]
        if len(companies) >= p["maxHostedCompanies"]:
            raise Refused("refused: maxHostedCompanies %d reached (current %d)" % (p["maxHostedCompanies"], len(companies)))
        agents = 0
        for c in companies:
            agents += sum(1 for a in self.api.get("/api/companies/%s/agents" % c["id"]) if str(a.get("status") or "").lower() != "terminated")
        adds = req.get("agents") or p["agentsPerNewCompany"]
        if agents + adds > p["maxAgentsTotal"]:
            raise Refused("refused: maxAgentsTotal %d would be exceeded (current %d, request adds %d)" % (p["maxAgentsTotal"], agents, adds))
        return {"companies": len(companies), "agents": agents, "adds": adds}

    # --- one request ---
    def process(self, fname):
        src = self.path("incoming", fname)
        req = load_json(src)
        rid = (req or {}).get("id") if isinstance(req, dict) else None
        if not rid or not ID_RE.match(rid) or fname != rid + ".json":
            os.rename(src, self.path("work", "bad-" + re.sub(r"[^A-Za-z0-9._-]", "_", fname)))
            return None
        token = req.pop("token", None)
        os.unlink(src)  # the token now lives only in memory; the result file below never holds it
        try:
            self.kill_switch()
            self.check_request(req)
            me = self.prove_identity(token)
            req["requester"] = {"id": me["id"], "name": me.get("name")}
            self.check_issue(req, me)
            self.check_open_and_done(req)
            gate = self.capacity(req)
        except Refused as e:
            return self.finish(rid, req, "refused", str(e))
        except RuntimeError as e:
            return self.finish(rid, req, "failed", "intake could not complete: %s" % e)
        finally:
            token = None
        self.save_result(rid, req, "running", "accepted; capacity %(companies)d companies, %(agents)d agents, request adds %(adds)d" % gate)
        if self.steps is None:
            return self.finish(rid, req, "failed", "no provisioning steps are installed in this runner")
        try:
            out = self.steps.run(self, rid, req)
        except Exception as e:  # a step failure fails the request, with the step's own message
            return self.finish(rid, req, "failed", str(e), **getattr(e, "extra", {}))
        return self.finish(rid, req, "done", out.pop("message", "provisioned"), **out)

    def finish(self, rid, req, status, message, **extra):
        r = self.save_result(rid, req, status, message, **extra)
        self.comment(req, r)
        return r

    def comment(self, req, r):
        ref = req.get("issue")
        if not ref:
            return
        body = "Provisioning request `%s` (%s): **%s**\n\n%s" % (r["id"], req.get("name"), r["status"].upper(), r["message"])
        if r.get("owner_list_url"):
            body += "\n\nOwner list: %s" % r["owner_list_url"]
        try:
            iss = self.api.get("/api/issues/" + ref)
            self.api.post("/api/issues/%s/comments" % iss["id"], {"body": body})
        except (RuntimeError, KeyError, TypeError) as e:
            sys.stderr.write("provision-runner: could not comment on %s: %s\n" % (ref, e))

    def run_all(self):
        lock = open(self.path("work", "runner.lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0  # another runner is working; the path unit fires again
        n = 0
        for fname in sorted(os.listdir(self.path("incoming"))):
            if fname.startswith(".") or not fname.endswith(".json"):
                continue
            self.process(fname)
            n += 1
        return n


def main():
    try:
        policy = load_policy()
    except Refused as e:
        sys.stderr.write("provision-runner: %s\n" % e)
        return 1
    token = ""
    try:
        with open(policy.get("boardTokenFile", "/etc/pib-provision/board-token")) as fh:
            token = fh.read().strip()
    except OSError:
        sys.stderr.write("provision-runner: cannot read the board token file\n")
        return 1
    steps = None
    try:
        sys.path.insert(0, HERE)
        import provision_steps as steps  # noqa: E402
    except ImportError:
        steps = None
    Runner(policy, Api(policy["apiBase"], token), SPOOL, steps).run_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
