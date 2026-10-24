"""Intake, policy and capacity-gate tests for provision-runner. Run: python3 -m unittest discover -s tools/provisioning/tests"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_loader = importlib.machinery.SourceFileLoader("provision_runner", os.path.join(ROOT, "provision-runner.py"))
_spec = importlib.util.spec_from_loader("provision_runner", _loader)
pr = importlib.util.module_from_spec(_spec)
_loader.exec_module(pr)

PAR = "par-company"


class FakeApi:
    def __init__(self, companies=None, agents=None, me=None, issue=None):
        self.companies = companies if companies is not None else [{"id": PAR, "status": "active"}]
        self.agents = agents or {}  # company id -> list of agent dicts
        self.me = me if me is not None else {"id": "a1", "companyId": PAR, "name": "Op", "role": "general", "title": "Operator", "status": "idle"}
        self.issue = issue if issue is not None else {"id": "iss-1", "companyId": PAR, "assigneeAgentId": "a1"}
        self.comments, self.tokens_seen = [], []

    def agent_get(self, path, token):
        self.tokens_seen.append(token)
        if token != "good":
            raise RuntimeError("GET %s -> HTTP 401" % path)
        return self.me

    def get(self, path):
        if path == "/api/companies":
            return self.companies
        if path.startswith("/api/issues/"):
            if self.issue is None:
                raise RuntimeError("HTTP 404")
            return self.issue
        if path.endswith("/agents"):
            return self.agents.get(path.split("/")[3], [])
        raise AssertionError(path)

    def post(self, path, body, timeout=60):
        self.comments.append((path, body))
        return {}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="provtest-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.policy = json.load(open(os.path.join(ROOT, "provision-policy.json")))
        self.policy["parCompanyId"] = PAR
        self.policy["setupProfileWired"] = True
        self.n = 0

    def runner(self, api, steps=None, **policy):
        self.policy.update(policy)
        return pr.Runner(self.policy, api, self.dir, steps)

    def file(self, r, **over):
        self.n += 1
        req = {"id": "p-20261024-120000-%06x" % self.n, "kind": "company", "name": "Acme", "crm_company_id": "crm-1", "issue": "PAR-9",
               "profile": "client", "plan": None, "modules": [], "agents": None, "model_key": True, "token": "good"}
        req.update(over)
        with open(os.path.join(self.dir, "incoming", req["id"] + ".json"), "w") as fh:
            json.dump(req, fh)
        return req["id"]

    def go(self, r, **over):
        rid = self.file(r, **over)
        return r.process(rid + ".json")


class Steps:
    def run(self, runner, rid, req):
        return {"message": "ok", "company_id": "new-co", "prefix": "ACM"}


class IntakeTests(Base):
    def test_accepted_runs_steps_and_drops_token(self):
        api = FakeApi()
        r = self.runner(api, Steps())
        res = self.go(r)
        self.assertEqual(res["status"], "done")
        self.assertEqual(res["company_id"], "new-co")
        self.assertEqual(os.listdir(os.path.join(self.dir, "incoming")), [])
        for n in os.listdir(os.path.join(self.dir, "results")):
            self.assertNotIn("good", open(os.path.join(self.dir, "results", n)).read())
        self.assertIn("/api/issues/iss-1/comments", api.comments[0][0])

    def test_kill_switch_policy_and_file(self):
        r = self.runner(FakeApi(), Steps(), enabled=False)
        self.assertIn("switched off in the policy", self.go(r)["message"])
        r = self.runner(FakeApi(), Steps(), enabled=True)
        open(os.path.join(self.dir, "DISABLED"), "w").close()
        self.assertIn("DISABLED", self.go(r)["message"])

    def test_requires_valid_token_and_role_and_company(self):
        r = self.runner(FakeApi(), Steps())
        self.assertIn("did not accept", self.go(r, token="bad")["message"])
        self.assertIn("no token", self.go(r, token=None)["message"])
        api = FakeApi(me={"id": "a1", "companyId": PAR, "name": "Developer", "role": "engineer", "status": "idle"})
        self.assertIn("only operator or account manager", self.go(self.runner(api, Steps()))["message"])
        api = FakeApi(me={"id": "a1", "companyId": "other", "name": "Operator", "role": "general", "status": "idle"})
        self.assertIn("PAR company", self.go(self.runner(api, Steps()))["message"])
        api = FakeApi(me={"id": "a1", "companyId": PAR, "name": "Operator", "role": "engineer", "title": "Developer", "status": "idle"})
        self.assertIn("only operator or account manager", self.go(self.runner(api, Steps()))["message"])  # a name alone is not a role
        api = FakeApi(me={"id": "a1", "companyId": PAR, "name": "Ann", "role": "general", "title": "Account Manager", "status": "idle"})
        self.assertEqual(self.go(self.runner(api, Steps()))["status"], "done")

    def test_issue_must_exist_and_belong_to_requester(self):
        api = FakeApi()
        api.issue = None
        self.assertIn("not found", self.go(self.runner(api, Steps()))["message"])
        api = FakeApi(issue={"id": "i", "companyId": PAR, "assigneeAgentId": "someone-else"})
        self.assertIn("not the assignee", self.go(self.runner(api, Steps()))["message"])
        api = FakeApi(issue={"id": "i", "companyId": "other", "assigneeAgentId": "a1"})
        self.assertIn("not in the PAR company", self.go(self.runner(api, Steps()))["message"])

    def test_client_without_model_key_is_refused_but_internal_is_not(self):
        r = self.runner(FakeApi(), Steps())
        self.assertIn("own model key", self.go(r, model_key=False)["message"])
        self.assertEqual(self.go(r, model_key=False, profile="internal", crm_company_id="crm-2")["status"], "done")

    def test_one_open_request_per_crm_company_and_no_repeat_after_done(self):
        r = self.runner(FakeApi(), Steps())
        pr.write_json(os.path.join(self.dir, "results", "p-20261024-000000-aaaaaa.json"),
                      {"id": "p-20261024-000000-aaaaaa", "status": "running", "crm_company_id": "crm-1", "updated": pr.now()})
        self.assertIn("still open", self.go(r)["message"])
        pr.write_json(os.path.join(self.dir, "results", "p-20261024-000000-aaaaaa.json"),
                      {"id": "p-20261024-000000-aaaaaa", "status": "done", "crm_company_id": "crm-1", "company_id": "c9"})
        self.assertIn("already provisioned", self.go(r)["message"])
        self.assertEqual(self.go(r, crm_company_id="crm-2")["status"], "done")

    def test_failed_earlier_request_does_not_block_a_retry(self):
        r = self.runner(FakeApi(), Steps())
        pr.write_json(os.path.join(self.dir, "results", "p-20261024-000000-aaaaaa.json"),
                      {"id": "p-20261024-000000-aaaaaa", "status": "failed", "crm_company_id": "crm-1"})
        self.assertEqual(self.go(r)["status"], "done")

    def test_step_failure_fails_the_request_with_its_message(self):
        class Boom:
            def run(self, *a):
                raise RuntimeError("copy-company-secrets FAIL; undo file /root/x.undo")
        res = self.go(self.runner(FakeApi(), Boom()))
        self.assertEqual(res["status"], "failed")
        self.assertIn("undo file", res["message"])

    def test_requested_agents_below_policy_minimum_still_counts_the_minimum(self):
        agents = {PAR: [{"status": "idle"}] * 56}
        res = self.go(self.runner(FakeApi(agents=agents), Steps()), agents=1)
        self.assertEqual(res["message"], "refused: maxAgentsTotal 60 would be exceeded (current 56, request adds 5)")

    def test_client_profile_refused_at_intake_until_setup_is_wired(self):
        api = FakeApi()
        res = self.go(self.runner(api, Steps(), setupProfileWired=False))
        self.assertIn("PAR-5157", res["message"])
        self.assertEqual(res["status"], "refused")
        self.assertEqual(self.go(self.runner(api, Steps(), setupProfileWired=False), profile="internal", model_key=False, crm_company_id="crm-3")["status"], "done")

    def test_plan_and_modules_are_validated(self):
        r = self.runner(FakeApi(), Steps())
        self.assertIn("plan", self.go(r, plan="x; rm -rf /")["message"])
        self.assertIn("modules", self.go(r, modules=["crm", "--apply"])["message"])

    def test_unverified_requests_get_no_comment_on_any_issue(self):
        api = FakeApi()
        res = self.go(self.runner(api, Steps()), token="bad", issue="PAR-1")
        self.assertEqual(res["status"], "refused")
        self.assertEqual(api.comments, [])
        api = FakeApi(issue={"id": "i", "companyId": PAR, "assigneeAgentId": "someone-else"})
        self.go(self.runner(api, Steps()))
        self.assertEqual(api.comments, [])

    def test_kill_switch_comments_once_identity_is_proven(self):
        api = FakeApi()
        self.go(self.runner(api, Steps(), enabled=False))
        self.assertEqual(len(api.comments), 1)

    def test_bad_file_never_kept_and_symlink_is_ignored(self):
        r = self.runner(FakeApi(), Steps())
        with open(os.path.join(self.dir, "incoming", "p-20261024-000000-bbbbbb.json"), "w") as fh:
            json.dump({"id": "other", "token": "good"}, fh)
        r.process("p-20261024-000000-bbbbbb.json")
        self.assertEqual(os.listdir(os.path.join(self.dir, "incoming")), [])
        self.assertEqual(os.listdir(os.path.join(self.dir, "work")), [])
        secret = os.path.join(self.dir, "secret.json")
        json.dump({"id": "p-20261024-000000-cccccc", "kind": "company", "token": "good"}, open(secret, "w"))
        os.symlink(secret, os.path.join(self.dir, "incoming", "p-20261024-000000-cccccc.json"))
        self.assertIsNone(r.process("p-20261024-000000-cccccc.json"))
        self.assertEqual(r.result("p-20261024-000000-cccccc"), None)

    def test_final_result_is_never_overwritten_and_replay_is_ignored(self):
        r = self.runner(FakeApi(), Steps())
        rid = self.file(r)
        self.assertEqual(r.process(rid + ".json")["status"], "done")
        before = r.result(rid)
        with open(os.path.join(self.dir, "incoming", rid + ".json"), "w") as fh:
            json.dump({"id": rid, "kind": "company", "token": "good"}, fh)
        self.assertIsNone(r.process(rid + ".json"))
        self.assertEqual(r.result(rid), before)

    def test_stale_running_result_does_not_block_forever(self):
        r = self.runner(FakeApi(), Steps())
        old = {"id": "p-20261024-000000-aaaaaa", "status": "running", "crm_company_id": "crm-1", "updated": "2026-10-20T00:00:00Z"}
        pr.write_json(os.path.join(self.dir, "results", old["id"] + ".json"), old)
        self.assertEqual(self.go(r)["status"], "done")

    def test_crash_in_intake_writes_a_failed_result(self):
        api = FakeApi()
        api.get = lambda path: (_ for _ in ()).throw(ValueError("boom")) if path == "/api/companies" else FakeApi.get(api, path)
        res = self.go(self.runner(api, Steps()))
        self.assertEqual(res["status"], "failed")
        self.assertIn("boom", res["message"])

    def test_bad_file_is_set_aside(self):
        r = self.runner(FakeApi(), Steps())
        with open(os.path.join(self.dir, "incoming", "junk.json"), "w") as fh:
            fh.write("{not json")
        self.assertIsNone(r.process("junk.json"))
        self.assertEqual(os.listdir(os.path.join(self.dir, "incoming")), [])


class CapacityTests(Base):
    def test_policy_starts_at_three_companies_and_sixty_agents(self):
        self.assertEqual(self.policy["maxHostedCompanies"], 3)
        self.assertEqual(self.policy["maxAgentsTotal"], 60)

    def test_company_limit_refuses_with_count(self):
        api = FakeApi(companies=[{"id": PAR}, {"id": "c2"}, {"id": "c3"}])
        res = self.go(self.runner(api, Steps()))
        self.assertEqual(res["status"], "refused")
        self.assertEqual(res["message"], "refused: maxHostedCompanies 3 reached (current 3)")

    def test_archived_companies_do_not_count(self):
        api = FakeApi(companies=[{"id": PAR}, {"id": "c2"}, {"id": "c3", "status": "archived"}])
        self.assertEqual(self.go(self.runner(api, Steps()))["status"], "done")

    def test_agent_limit_refuses_with_count_and_adds(self):
        agents = {PAR: [{"status": "idle"}] * 50, "c2": [{"status": "idle"}] * 8}
        api = FakeApi(companies=[{"id": PAR}, {"id": "c2"}], agents=agents)
        res = self.go(self.runner(api, Steps()), agents=4)
        self.assertEqual(res["message"], "refused: maxAgentsTotal 60 would be exceeded (current 58, request adds 5)")  # agents=4 is raised to the policy minimum of 5

    def test_agent_limit_allows_exactly_the_limit_and_skips_terminated(self):
        agents = {PAR: [{"status": "idle"}] * 55 + [{"status": "terminated"}] * 9}
        api = FakeApi(companies=[{"id": PAR}], agents=agents)
        self.assertEqual(self.go(self.runner(api, Steps()), agents=5)["status"], "done")
        self.assertEqual(self.go(self.runner(api, Steps()), agents=6, crm_company_id="crm-2")["status"], "refused")

    def test_default_adds_comes_from_policy(self):
        agents = {PAR: [{"status": "idle"}] * 56}
        res = self.go(self.runner(FakeApi(agents=agents), Steps()))
        self.assertIn("current 56, request adds 5", res["message"])

    def test_limits_live_in_the_policy_not_the_code(self):
        api = FakeApi(companies=[{"id": PAR}, {"id": "c2"}, {"id": "c3"}])
        self.assertEqual(self.go(self.runner(api, Steps(), maxHostedCompanies=4))["status"], "done")

    def test_policy_without_limits_fails_closed(self):
        p = dict(self.policy)
        del p["maxAgentsTotal"]
        path = os.path.join(self.dir, "p.json")
        json.dump(p, open(path, "w"))
        with self.assertRaises(pr.Refused):
            pr.load_policy(path)


if __name__ == "__main__":
    unittest.main()
