"""Step-by-step tests for provision_steps. Server commands and the Paperclip API are faked; nothing real is touched."""
import json
import os
import sys
import types
import unittest
from unittest import mock

import test_intake as ti

sys.path.insert(0, ti.ROOT)
import provision_steps as ps  # noqa: E402


def hire(n, status="done"):
    return {"id": "t%d" % n, "identifier": "ACM-%d" % n, "title": "Hire: Agent %d" % n, "status": status, "originKind": "plugin:partnersinbiz.setup"}


class Clock:
    """Stands in for the time module in provision_steps: sleeping moves the clock, nothing really waits."""

    def __init__(self):
        self.t = 1000.0

    def time(self):
        return self.t

    def sleep(self, n):
        self.t += n


class StepApi(ti.FakeApi):
    def __init__(self, hires=5, crm_ok=True, tasks=None, catalog=None, catalog_error=None, bound=True, **kw):
        super().__init__(**kw)
        self.posts, self.hires, self.crm_ok = [], hires, crm_ok
        self.tasks = [hire(i) for i in range(4)] if tasks is None else tasks  # a list, or a function of the poll number
        self.task_polls = 0
        # fake secrets catalog: metadata only, as the host returns it (id, name, key, status), never a value
        self.catalog = [{"id": "sec-1", "name": "ANTHROPIC_API_KEY", "key": "ANTHROPIC_API_KEY", "status": "active"}] if catalog is None else catalog
        self.catalog_error, self.bound, self.gets = catalog_error, bound, []
        self._board = "board-secret-token"

    def get(self, path):
        self.gets.append(path)
        if path == "/api/companies/new-co/secrets/catalog":
            if self.catalog_error:
                raise RuntimeError("GET %s -> HTTP %d" % (path, self.catalog_error))
            return self.catalog
        if path == "/api/companies/new-co":
            return {"id": "new-co", "name": "Acme", "issuePrefix": "ACM"}
        if path.startswith("/api/companies/new-co/issues"):
            self.task_polls += 1
            return self.tasks(self.task_polls) if callable(self.tasks) else self.tasks
        if path == "/api/companies/new-co/agents":
            env = {"ANTHROPIC_API_KEY": {"type": "secret_ref", "secretId": "sec-1"}} if self.bound else {}
            return [{"id": "ag%d" % i, "name": n, "role": "general", "title": n, "status": "idle", "adapterType": "claude_local", "adapterConfig": {"env": env}}
                    for i, n in enumerate(["CEO", "Account Manager", "SEO Specialist", "Social Manager", "Operator"][: self.hires])]
        return super().get(path)

    def post(self, path, body, timeout=60):
        self.posts.append((path, body))
        if path == "/api/companies":
            return {"id": "new-co", "name": body["name"]}
        if path == "/api/plugins/tools/execute" and body["tool"] == "crm:get-company":
            return {"data": {"custom": {"hosted_company_id": "new-co" if self.crm_ok else "x"}}}
        return super().post(path, body, timeout)


class Cmds:
    """Records every server command; `fail` maps a substring of the command line to (exit code, output)."""

    def __init__(self, fail=None, outputs=None):
        self.calls, self.fail, self.outputs, self.envs = [], fail or {}, outputs or {}, []

    def __call__(self, argv, timeout, env=None):
        line = " ".join(argv)
        self.calls.append(line)
        self.envs.append(env or {})
        for k, v in self.fail.items():
            if k in line:
                return v
        for k, v in self.outputs.items():
            if k in line:
                return 0, v
        return 0, "ok"


class StepTests(ti.Base):
    def setUp(self):
        super().setUp()
        self.policy.update(setupProfileWired=True, setupRunnerCommand=["node", "setup.mjs", "--company", "{companyId}", "--profile", "{profile}"],
                           crmProjectId="proj-1", ownerListUrlTemplate="https://x.example/{prefix}/owner-list")

    def run_req(self, api=None, cmds=None, **over):
        api, cmds = api or StepApi(), cmds or Cmds()
        r = self.runner(api, ps)
        clock = Clock()
        with mock.patch.object(ps, "exec_cmd", cmds), mock.patch.object(ps, "time", types.SimpleNamespace(time=clock.time, sleep=clock.sleep)):
            return self.go(r, **over), api, cmds

    def test_happy_path_order_and_result(self):
        res, api, cmds = self.run_req()
        self.assertEqual(res["status"], "done", res["message"])
        order = [c.split("/")[-1].split(" ")[0] if "pib-ops" in c else c.split(" ")[0] for c in cmds.calls]
        self.assertEqual(order, ["new-company.py", "node", "copy-company-secrets.py", "new-company.py", "new-company.py", "new-company.py"])
        self.assertIn("--company ACM --create-ceo --apply", cmds.calls[0])
        self.assertIn("copy-company-secrets.py --profile client --from par-company --to ACM --apply", cmds.calls[2])
        self.assertTrue(cmds.calls[3].endswith("--company ACM --apply"))
        self.assertTrue(cmds.calls[4].endswith("--model-key-bind --apply"))
        self.assertTrue(cmds.calls[5].endswith("--verify"))
        self.assertEqual(res["owner_list_url"], "https://x.example/ACM/owner-list")
        self.assertIn("https://x.example/ACM/owner-list", api.comments[-1][1]["body"])

    def test_link_agent_called_for_unlinked_roles_only(self):
        res, api, _ = self.run_req()
        links = [b for p, b in api.posts if p.endswith("/actions/link-agent")]
        plugins = sorted(p for p, _ in api.posts if p.endswith("/actions/link-agent"))
        self.assertEqual(len(links), 3)
        self.assertEqual([p.split("/")[3] for p in plugins], ["partnersinbiz.crm", "partnersinbiz.seo", "partnersinbiz.social"])

    def test_never_posts_to_issues_of_the_new_company(self):
        _, api, _ = self.run_req()
        issue_posts = [p for p, _ in api.posts if "/issues" in p]
        self.assertEqual(issue_posts, ["/api/issues/iss-1/comments"])  # only the requesting PAR issue gets the result comment

    def test_client_profile_waits_on_task_2_1_and_creates_nothing(self):
        self.policy["setupProfileWired"] = False
        res, api, cmds = self.run_req()
        self.assertEqual(res["status"], "refused")
        self.assertIn("PAR-5157", res["message"])
        self.assertEqual(cmds.calls, [])
        self.assertEqual([p for p, _ in api.posts if p == "/api/companies"], [])

    def test_unsafe_prefix_from_host_is_not_passed_to_scripts(self):
        api = StepApi()
        api.get = lambda path: {"id": "new-co", "name": "Acme", "issuePrefix": "A; id"} if path == "/api/companies/new-co" else StepApi.get(api, path)
        res, _, cmds = self.run_req(api=api)
        self.assertEqual(res["status"], "failed")
        self.assertEqual(cmds.calls, [])

    def test_setup_run_gets_profile_param_and_board_token_in_env_not_argv(self):
        _, _, cmds = self.run_req()
        line = cmds.calls[1]
        self.assertEqual(line, "node setup.mjs --company new-co --profile client")
        self.assertEqual(cmds.envs[1], {"PIB_BOARD_TOKEN": "board-secret-token"})
        self.assertNotIn("board-secret-token", " ".join(cmds.calls))

    def test_keys_failure_stops_and_names_undo_file(self):
        cmds = Cmds(fail={"copy-company-secrets.py": (1, "step 3 FAIL\nundo with: /root/pib-ops/undo/ACM-1.undo.json")})
        res, _, cmds = self.run_req(cmds=cmds)
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["undo_file"], "/root/pib-ops/undo/ACM-1.undo.json")
        self.assertIn("/root/pib-ops/undo/ACM-1.undo.json", res["message"])
        self.assertFalse(any("--verify" in c or "model-key" in c for c in cmds.calls))
        self.assertEqual(res["company_id"], "new-co")

    def test_model_key_step_runs_with_a_key_and_no_key_is_refused_before_any_command(self):
        res, _, cmds = self.run_req()
        self.assertEqual(res["status"], "done", res["message"])
        self.assertTrue(any("--model-key-bind" in c for c in cmds.calls))
        res, _, cmds = self.run_req(model_key=False)
        self.assertEqual(res["status"], "refused")
        self.assertEqual(cmds.calls, [])

    def test_copy_secrets_always_runs_with_profile_client_and_named_source(self):
        res, _, cmds = self.run_req()
        copy = [c for c in cmds.calls if "copy-company-secrets.py" in c]
        self.assertEqual(len(copy), 1)
        self.assertIn("--profile client --from par-company --to ACM --apply", copy[0])
        res, _, cmds = self.run_req(profile="internal")
        self.assertEqual(res["status"], "refused")
        self.assertFalse(any("copy-company-secrets.py" in c for c in cmds.calls))

    def test_verify_warn_fails_the_request(self):
        res, _, _ = self.run_req(cmds=Cmds(outputs={"--verify": "ok\nWARN model key not bound for agent ag1\n"}))
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["step"], "verify")
        self.assertIn("WARN model key", res["message"])

    def test_hires_all_done_and_agents_is_not_a_wait_count(self):
        res, api, _ = self.run_req(agents=9)  # 5 live agents, 4 done hire tasks: --agents 9 must not make the step wait for 9
        self.assertEqual(res["status"], "done", res["message"])
        self.assertGreaterEqual(api.task_polls, 2)  # two confirming polls
        self.assertEqual([p for p, _ in api.posts if "comments" in p], ["/api/issues/iss-1/comments"])  # never touches a hire task

    def test_hires_some_cancelled_still_passes(self):
        res, _, _ = self.run_req(api=StepApi(tasks=[hire(1), hire(2), hire(3, "cancelled")], hires=3))
        self.assertEqual(res["status"], "done", res["message"])

    def test_hires_none_found_fails_never_succeeds(self):
        res, api, _ = self.run_req(api=StepApi(tasks=[]))
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["step"], "hires")
        self.assertIn("no hire tasks found", res["message"])

    def test_hires_ignores_tasks_that_are_not_plugin_hire_tasks(self):
        other = [{"id": "x", "identifier": "ACM-9", "title": "Hire: Someone", "status": "done", "originKind": "manual"},
                 {"id": "y", "identifier": "ACM-10", "title": "Welcome", "status": "done", "originKind": "plugin:partnersinbiz.setup"}]
        res, _, _ = self.run_req(api=StepApi(tasks=other))
        self.assertEqual(res["status"], "failed")
        self.assertIn("no hire tasks found", res["message"])

    def test_hires_resume_of_a_staffed_company_passes_with_a_note(self):
        self.prior("failed", "verify", ["create-company", "entitlements", "create-ceo", "setup-run", "copy-secrets"])
        res, api, _ = self.run_req(api=StepApi(tasks=[], hires=5))
        self.assertEqual(res["status"], "done", res["message"])
        self.assertIn("already staffed", res["message"])

    def test_hires_resume_of_a_thin_company_with_no_tasks_still_fails(self):
        self.prior("failed", "hires", ["create-company", "entitlements", "create-ceo", "setup-run", "copy-secrets"])
        res, _, _ = self.run_req(api=StepApi(tasks=[], hires=1))
        self.assertEqual(res["status"], "failed")
        self.assertIn("no hire tasks found", res["message"])

    def test_hires_terminal_tasks_but_missing_agents_fail_with_both_numbers(self):
        res, _, _ = self.run_req(api=StepApi(hires=2))  # 4 done tasks, 2 live agents
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["step"], "hires")
        self.assertIn("4 hire tasks are done", res["message"])
        self.assertIn("only 2 live agents", res["message"])

    def test_hires_transient_block_that_clears_passes(self):
        api = StepApi(tasks=lambda n: [hire(1), hire(2, "blocked" if n <= 3 else "done")])
        res, _, _ = self.run_req(api=api)
        self.assertEqual(res["status"], "done", res["message"])

    def test_hires_block_at_the_deadline_is_needs_owner(self):
        self.policy["stepTimeouts"] = {"hires": 60}
        res, api, _ = self.run_req(api=StepApi(tasks=[hire(1), hire(2, "blocked")]))
        self.assertEqual(res["status"], "needs_owner")
        self.assertEqual(res["step"], "hires")
        self.assertIn("ACM-2", res["message"])
        self.assertEqual(res["company_id"], "new-co")
        self.assertIn("NEEDS_OWNER", api.comments[-1][1]["body"])  # the result comment says so

    def test_hires_timeout_lists_the_open_tasks_and_fails(self):
        self.policy["stepTimeouts"] = {"hires": 60}
        res, _, _ = self.run_req(api=StepApi(tasks=[hire(1), hire(2, "in_progress"), hire(3, "blocked")]))
        self.assertEqual(res["status"], "failed")
        self.assertIn("ACM-2 (in_progress)", res["message"])
        self.assertIn("ACM-3 (blocked)", res["message"])

    def test_needs_owner_request_is_resumed_without_a_second_company(self):
        self.policy.update(stepTimeouts={"hires": 60}, maxHostedCompanies=2)
        res, api, _ = self.run_req(api=StepApi(tasks=[hire(1), hire(2, "blocked")]))
        self.assertEqual(res["status"], "needs_owner")
        api2 = StepApi(companies=[{"id": ti.PAR, "status": "active"}, {"id": "new-co", "status": "active"}])  # the owner acted: hire tasks are done now
        res2, api2, cmds2 = self.run_req(api=api2)
        self.assertEqual(res2["status"], "done", res2["message"])  # not refused as open, not refused by maxHostedCompanies 2
        self.assertEqual([p for p, _ in api2.posts if p == "/api/companies"], [])
        self.assertFalse(any("--create-ceo" in c for c in cmds2.calls))

    def test_needs_owner_company_counts_once_for_capacity(self):
        self.policy.update(maxHostedCompanies=2)
        self.prior("needs_owner", "hires", ["create-company", "entitlements", "create-ceo", "setup-run", "copy-secrets"])
        api = StepApi(companies=[{"id": ti.PAR, "status": "active"}, {"id": "new-co", "status": "active"}])
        r = self.runner(api, ps)
        gate = r.capacity({"agents": None}, resume="new-co")
        self.assertEqual(gate["companies"], 2)
        with self.assertRaises(ti.pr.Refused):
            r.capacity({"agents": None}, resume=None)

    def test_prior_failed_matches_needs_owner(self):
        self.prior("needs_owner", "hires", ["create-company"])
        r = self.runner(StepApi(), ps)
        found = ps.prior_failed(r, {"crm_company_id": "crm-1"}, "p-other")
        self.assertEqual(found["status"], "needs_owner")

    def test_key_gate_missing_secret_is_needs_owner_before_any_agent_exists(self):
        res, api, cmds = self.run_req(api=StepApi(catalog=[]))
        self.assertEqual(res["status"], "needs_owner")
        self.assertEqual(res["step"], "key-gate")
        self.assertIn("add secret ANTHROPIC_API_KEY on the Secrets page of ACM (Setup, Model key step)", res["message"])
        self.assertEqual(cmds.calls, [])  # no create-ceo, no Setup run: no agent was created
        self.assertEqual([p for p, _ in api.posts], ["/api/companies", "/api/issues/iss-1/comments"])  # a company and the result comment; nothing hired, linked or run
        self.assertEqual(res["company_id"], "new-co")

    def test_key_gate_inactive_or_other_names_do_not_pass(self):
        for cat in ([{"id": "s", "name": "ANTHROPIC_API_KEY", "status": "disabled"}],
                    [{"id": "s", "name": "ANTHROPIC_API_KEY_OLD", "status": "active"}, {"id": "t", "name": "anthropic_api_key", "status": "active"}]):
            res, _, cmds = self.run_req(api=StepApi(catalog=cat))
            self.assertEqual(res["status"], "needs_owner", cat)
            self.assertEqual(cmds.calls, [])

    def test_key_gate_present_continues(self):
        res, api, _ = self.run_req()
        self.assertEqual(res["status"], "done", res["message"])
        self.assertIn("key gate", res["message"])
        self.assertIn("/api/companies/new-co/secrets/catalog", api.gets)

    def test_key_gate_runs_after_entitlements_and_before_create_ceo(self):
        self.assertEqual([n for n, _ in ps.STEPS][:4], ["create-company", "entitlements", "key-gate", "create-ceo"])

    def test_key_gate_http_error_fails_with_the_status_code(self):
        for code in (403, 500):
            res, _, cmds = self.run_req(api=StepApi(catalog_error=code))
            self.assertEqual(res["status"], "failed")
            self.assertEqual(res["step"], "key-gate")
            self.assertIn("HTTP %d" % code, res["message"])
            self.assertEqual(cmds.calls, [])

    def test_key_gate_resume_reruns_the_gate_and_reuses_the_company(self):
        res, api, cmds = self.run_req(api=StepApi(catalog=[]))
        self.assertEqual(res["status"], "needs_owner")
        res2, api2, cmds2 = self.run_req(api=StepApi())  # the owner added the secret
        self.assertEqual(res2["status"], "done", res2["message"])
        self.assertIn("/api/companies/new-co/secrets/catalog", api2.gets)
        self.assertEqual([p for p, _ in api2.posts if p == "/api/companies"], [])
        self.assertTrue(any("--create-ceo" in c for c in cmds2.calls))

    def test_key_gate_skipped_without_a_model_key(self):
        self.runner(StepApi(), ps)
        c = types.SimpleNamespace(req={"model_key": False}, st={}, api=StepApi(catalog_error=500))
        ps.step_key_gate(c)  # never calls the API
        self.assertIn("skipped", c.st["note_key_gate"])

    def test_model_key_step_stops_if_the_secret_vanished(self):
        api = StepApi()
        calls = []
        orig = api.get

        def get(path):
            if path.endswith("/secrets/catalog"):
                calls.append(path)
                return api.catalog if len(calls) == 1 else []  # present at the gate, gone at step 9
            return orig(path)
        api.get = get
        res, _, cmds = self.run_req(api=api)
        self.assertEqual(res["status"], "needs_owner")
        self.assertEqual(res["step"], "model-key")
        self.assertFalse(any("--model-key-bind" in c for c in cmds.calls))

    def test_model_key_readback_requires_a_secret_ref_on_the_first_claude_local_agent(self):
        res, _, _ = self.run_req(api=StepApi(bound=False))
        self.assertEqual(res["status"], "failed")
        self.assertEqual(res["step"], "model-key")
        self.assertIn("no env.ANTHROPIC_API_KEY secret_ref", res["message"])

    def test_model_key_readback_rejects_a_plain_value_and_never_prints_it(self):
        api = StepApi()
        orig = api.get
        plain = "plain-fake-value-123"

        def get(path):
            rows = orig(path)
            if path == "/api/companies/new-co/agents":
                for a in rows:
                    a["adapterConfig"]["env"] = {"ANTHROPIC_API_KEY": {"type": "plain", "value": plain}}
            return rows
        api.get = get
        res, _, _ = self.run_req(api=api)
        self.assertEqual(res["status"], "failed")
        self.assertNotIn(plain, json.dumps(res))

    def test_model_key_readback_fails_without_a_claude_local_agent(self):
        api = StepApi()
        orig = api.get
        api.get = lambda path: [dict(a, adapterType="codex_local") for a in orig(path)] if path == "/api/companies/new-co/agents" else orig(path)
        res, _, _ = self.run_req(api=api)
        self.assertEqual(res["status"], "failed")
        self.assertIn("no claude_local agent", res["message"])

    def test_no_key_value_in_argv_env_or_result(self):
        res, api, cmds = self.run_req()
        blob = json.dumps([cmds.calls, cmds.envs, res, api.posts, api.comments])
        self.assertNotIn("sk-ant", blob)
        self.assertNotIn("model_key", json.dumps(cmds.calls))

    def prior(self, status, step, done):
        os.makedirs(os.path.join(self.dir, "results"), exist_ok=True)
        old = {"id": "p-20261024-000000-aaaaaa", "status": status, "crm_company_id": "crm-1", "company_id": "new-co", "prefix": "ACM",
               "step": step, "steps_done": done, "updated": "2026-10-24T16:30:00Z"}
        with open(os.path.join(self.dir, "results", old["id"] + ".json"), "w") as fh:
            json.dump(old, fh)

    def test_crm_record_written_and_read_back(self):
        _, api, _ = self.run_req()
        tools = [b["tool"] for p, b in api.posts if p == "/api/plugins/tools/execute"]
        self.assertEqual(tools, ["crm:define-field", "crm:update-company", "crm:get-company"])
        upd = [b for p, b in api.posts if p == "/api/plugins/tools/execute" and b["tool"] == "crm:update-company"][0]
        self.assertEqual(upd["parameters"], {"companyRecordId": "crm-1", "custom": {"hosted_company_id": "new-co"}})

    def test_crm_readback_mismatch_fails(self):
        res, _, _ = self.run_req(api=StepApi(crm_ok=False))
        self.assertEqual(res["step"], "crm-record")
        self.assertIn("did not read back", res["message"])

    def test_failed_request_is_resumed_without_a_second_company(self):
        cmds = Cmds(fail={"--verify": (1, "FAIL something")})
        res, api, _ = self.run_req(cmds=cmds)
        self.assertEqual(res["step"], "verify")
        n_created = lambda a: len([1 for p, _ in a.posts if p == "/api/companies"])  # noqa: E731
        self.assertEqual(n_created(api), 1)
        res2, api2, cmds2 = self.run_req(api=StepApi())
        self.assertEqual(res2["status"], "done", res2["message"])
        self.assertEqual(n_created(api2), 0)  # reused new-co
        self.assertEqual(len(cmds2.calls), 1)  # only --verify ran again
        self.assertTrue(cmds2.calls[0].endswith("--verify"))

    def test_output_is_redacted(self):
        cmds = Cmds(fail={"new-company.py --company ACM --apply": (1, "boom key sk-ant-api03-ABCDEF123456 Bearer abc.def")})
        res, _, _ = self.run_req(cmds=cmds)
        self.assertNotIn("sk-ant", res["message"])
        self.assertNotIn("abc.def", res["message"])

    def test_entitlements_sent_when_plan_given(self):
        _, api, _ = self.run_req(plan="growth", modules=["crm", "seo"])
        ent = [b for p, b in api.posts if p.endswith("/actions/setup.set-entitlements")]
        self.assertEqual(ent[0]["params"], {"targetCompanyId": "new-co", "plan": "growth", "modules": {"crm": "entitled", "seo": "entitled"}})
        self.assertNotEqual(ent[0]["companyId"], "new-co")   # runs on the operator company's page, never the new company's


if __name__ == "__main__":
    unittest.main()
