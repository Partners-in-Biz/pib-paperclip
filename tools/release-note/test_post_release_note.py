import contextlib
import io
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import post_release_note as prn  # noqa: E402

TOKEN = "pcp_SECRET_TOKEN_0123456789"


class FakeClient:
    """In-memory stand-in for the Paperclip API."""

    def __init__(self, companies, fail_on=()):
        # companies: {company_id: {"origin": str|None, "comments": [body, ...], "companyId": str}}
        self.companies = companies
        self.fail_on = set(fail_on)
        self.posts = []
        self.calls = []

    def _issue_for(self, issue_id):
        for cid, c in self.companies.items():
            if c.get("origin") is not None and "issue-" + cid == issue_id:
                return cid, c
        raise prn.ApiError("unknown issue")

    def request(self, method, path, body=None):
        self.calls.append((method, path))
        if method == "GET" and path == "/api/companies":
            return [{"id": cid, "status": c.get("status", "active")} for cid, c in self.companies.items()]
        if method == "GET" and "/issues?" in path:
            cid = path.split("/")[3]
            if cid in self.fail_on:
                raise prn.ApiError("GET %s failed: HTTP 500" % path)
            c = self.companies[cid]
            if c.get("origin") is None:
                return []
            return [{"id": "issue-" + cid, "identifier": "SH-1", "originId": c["origin"]}]
        if method == "GET" and path.endswith(("order=desc&limit=500",)) and "/comments" in path:
            _, c = self._issue_for(path.split("/")[3])
            return [{"body": b} for b in reversed(c["comments"])]
        if method == "GET" and path.startswith("/api/issues/"):
            cid, c = self._issue_for(path.split("/")[3])
            return {"id": "issue-" + cid, "originId": c.get("fresh_origin", c["origin"]), "companyId": cid}
        if method == "POST":
            cid, c = self._issue_for(path.split("/")[3])
            self.posts.append((cid, body["body"]))
            c["comments"].append(body["body"])
            return {"id": "c1"}
        raise AssertionError("unexpected call %s %s" % (method, path))


def make_args(phase="planned", companies="co1", apply=True, **over):
    argv = [
        phase, "--deploy-id", "dep-1", "--plugin", "plugin-billing", "--version", "0.11.0",
        "--sha", "ABCDEF1234567", "--reason", "migration",
        "--window-start", "2026-10-26T01:00:00Z", "--window-end", "2026-10-26T04:00:00Z",
        "--downtime-minutes", "5", "--companies", companies,
    ]
    if apply:
        argv.append("--apply")
    for k, v in over.items():
        argv += ["--" + k.replace("_", "-"), v]
    return prn.build_parser().parse_args(argv)


def run(args, client):
    out, err = io.StringIO(), io.StringIO()
    code = prn.run(args, client, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def co(origin="cockpit:health:co1", **extra):
    d = {"origin": origin, "comments": []}
    d.update(extra)
    return d


class MarkerTests(unittest.TestCase):
    def test_comment_has_parseable_marker_first_line_and_short_body(self):
        args = make_args()
        text = prn.build_comment(args, "2026-10-26T01:00:00Z", "2026-10-26T04:00:00Z")
        first, *rest = text.split("\n")
        marker = prn.parse_marker(text)
        self.assertEqual(marker["id"], "dep-1")
        self.assertEqual(marker["phase"], "planned")
        self.assertEqual(marker["downtimeMinutes"], 5)
        self.assertEqual(list(marker)[0], "id")
        self.assertTrue(first.startswith("<!-- pib-release-note v1 {"))
        self.assertTrue(3 <= len(rest) <= 5)
        self.assertIn("abcdef1", text)
        self.assertNotIn("ABCDEF1234567", text)

    def test_each_phase_builds(self):
        for phase in prn.PHASES:
            text = prn.build_comment(make_args(phase), "2026-10-26T01:00:00Z", "2026-10-26T04:00:00Z")
            self.assertEqual(prn.parse_marker(text)["phase"], phase)

    def test_unknown_version_or_malformed_json_ignored(self):
        self.assertIsNone(prn.parse_marker('<!-- pib-release-note v2 {"id":"x"} -->\nbody'))
        self.assertIsNone(prn.parse_marker("<!-- pib-release-note v1 {not json} -->\nbody"))
        self.assertIsNone(prn.parse_marker("plain comment"))
        self.assertIsNone(prn.parse_marker(None))

    def test_offset_times_are_converted_to_utc(self):
        self.assertEqual(prn.parse_utc("2026-10-26T03:00:00+02:00", "x"), "2026-10-26T01:00:00Z")
        with self.assertRaises(ValueError):
            prn.parse_utc("2026-10-26T03:00:00", "x")

    def test_bad_inputs_rejected(self):
        for over in ({"plugin": "Bad Plugin"}, {"version": "1.2"}, {"sha": "zzz"}, {"deploy_id": "a b"}):
            code, _, err = run(make_args(**over), FakeClient({"co1": co()}))
            self.assertEqual(code, 2, over)
            self.assertIn("error:", err)

    def test_summary_is_kept_on_one_line(self):
        text = prn.build_comment(make_args(summary="Faster\ninvoices -->"), "2026-10-26T01:00:00Z", "2026-10-26T04:00:00Z")
        self.assertEqual(len(text.split("\n")), 6)
        self.assertEqual(len([l for l in text.split("\n") if "<!--" in l]), 1)


class PostingTests(unittest.TestCase):
    def test_dry_run_prints_target_and_text_and_writes_nothing(self):
        client = FakeClient({"co1": co()})
        code, out, _ = run(make_args(apply=False), client)
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN co1: would post", out)
        self.assertIn("<!-- pib-release-note v1", out)
        self.assertEqual(client.posts, [])
        self.assertFalse([c for c in client.calls if c[0] == "POST"])

    def test_apply_posts_once_and_rerun_posts_nothing(self):
        client = FakeClient({"co1": co(), "co2": co("cockpit:health:co2")})
        args = make_args(companies="co1,co2")
        self.assertEqual(run(args, client)[0], 0)
        self.assertEqual(sorted(c for c, _ in client.posts), ["co1", "co2"])
        code, out, _ = run(args, client)
        self.assertEqual(code, 0)
        self.assertEqual(len(client.posts), 2)
        self.assertIn("already posted", out)

    def test_same_id_other_phase_is_not_a_duplicate(self):
        client = FakeClient({"co1": co()})
        self.assertEqual(run(make_args("planned"), client)[0], 0)
        self.assertEqual(run(make_args("live"), client)[0], 0)
        self.assertEqual(len(client.posts), 2)

    def test_other_deploy_id_is_not_a_duplicate(self):
        client = FakeClient({"co1": co()})
        run(make_args(), client)
        a = make_args(deploy_id="dep-2")
        run(a, client)
        self.assertEqual(len(client.posts), 2)

    def test_failing_company_does_not_stop_others_and_exit_nonzero(self):
        client = FakeClient({"co1": co(), "co2": co("cockpit:health:co2")}, fail_on={"co1"})
        code, _, err = run(make_args(companies="co1,co2"), client)
        self.assertEqual(code, 1)
        self.assertEqual([c for c, _ in client.posts], ["co2"])
        self.assertIn("failed companies: co1", err)

    def test_refuses_when_origin_id_mismatches_at_lookup(self):
        client = FakeClient({"co1": co("cockpit:health:other")})
        code, _, err = run(make_args(), client)
        self.assertEqual(code, 1)
        self.assertEqual(client.posts, [])
        self.assertIn("refusing", err)

    def test_refuses_when_origin_id_changes_before_post(self):
        client = FakeClient({"co1": co(fresh_origin="cockpit:health:other")})
        code, _, err = run(make_args(), client)
        self.assertEqual(code, 1)
        self.assertEqual(client.posts, [])
        self.assertIn("mismatch", err)

    def test_company_without_health_issue_is_skipped_with_warning(self):
        client = FakeClient({"co1": co(None), "co2": co("cockpit:health:co2")})
        code, out, _ = run(make_args(companies="co1,co2"), client)
        self.assertEqual(code, 0)
        self.assertIn("WARNING co1: no System health issue", out)
        self.assertEqual([c for c, _ in client.posts], ["co2"])

    def test_all_skips_archived_companies(self):
        client = FakeClient({"co1": co(), "co2": co("cockpit:health:co2", status="archived")})
        run(make_args(companies="all"), client)
        self.assertEqual([c for c, _ in client.posts], ["co1"])

    def test_companies_flag_is_required(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            prn.build_parser().parse_args(["planned", "--deploy-id", "d"])


class TokenSafetyTests(unittest.TestCase):
    def _client_with_failing_urlopen(self, exc):
        client = prn.Client("https://paperclip.example/api", TOKEN)
        patcher = mock.patch("urllib.request.urlopen", side_effect=exc)
        patcher.start()
        self.addCleanup(patcher.stop)
        return client

    def test_token_never_in_output_or_errors_on_transport_failure(self):
        exc = urllib.error.URLError("connect failed for Bearer " + TOKEN)
        client = self._client_with_failing_urlopen(exc)
        code, out, err = run(make_args(), client)
        self.assertEqual(code, 1)  # explicit ids: each company fails on its own
        self.assertNotIn(TOKEN, out + err)

    def test_token_never_in_exception_text(self):
        for exc in (urllib.error.URLError("x " + TOKEN), RuntimeError(TOKEN),
                    urllib.error.HTTPError("https://x/" + TOKEN, 500, "boom " + TOKEN, {}, None)):
            client = self._client_with_failing_urlopen(exc)
            with self.assertRaises(prn.ApiError) as ctx:
                client.request("GET", "/api/companies")
            self.assertNotIn(TOKEN, str(ctx.exception))
            self.assertNotIn(TOKEN, repr(ctx.exception))
            self.assertIsNone(ctx.exception.__cause__)

    def test_token_not_printed_through_run_and_main(self):
        self._client_with_failing_urlopen(urllib.error.URLError(TOKEN))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            env = {"PAPERCLIP_API_KEY": TOKEN, "PAPERCLIP_API_URL": "https://paperclip.example/api"}
            with mock.patch.dict(os.environ, env):
                code = prn.main([
                    "planned", "--deploy-id", "d1", "--plugin", "plugin-billing", "--version", "1.0.0",
                    "--sha", "abcdef1", "--reason", "both", "--window-start", "2026-10-26T01:00:00Z",
                    "--window-end", "2026-10-26T04:00:00Z", "--downtime-minutes", "3",
                    "--companies", "all", "--apply"])
        self.assertNotEqual(code, 0)
        self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())

    def test_missing_env_exits_2_without_traceback(self):
        with mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stderr(io.StringIO()) as err:
            code = prn.main(["live", "--deploy-id", "d", "--plugin", "p", "--version", "1.0.0", "--sha", "abcdef1",
                             "--reason", "both", "--window-start", "2026-10-26T01:00:00Z",
                             "--window-end", "2026-10-26T04:00:00Z", "--downtime-minutes", "1",
                             "--companies", "co1"])
        self.assertEqual(code, 2)
        self.assertIn("must be set", err.getvalue())


if __name__ == "__main__":
    unittest.main()
