#!/usr/bin/env python3
"""Post a stop-first release note to each company's System health issue.

Python 3 standard library only. See README.md for the marker contract and the
runner wiring. Dry run unless --apply is given.

The credential is read from the environment (PAPERCLIP_API_KEY) and is never
printed, logged or put in an exception message.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

MARKER_PREFIX = "<!-- pib-release-note v1 "
MARKER_RE = re.compile(r"^<!-- pib-release-note v(\d+) (\{.*\}) -->\s*$")
PHASES = ("planned", "live", "cancelled")
REASONS = ("migration", "capability", "both")
COMMENT_SCAN_LIMIT = 500
HTTP_TIMEOUT_SECONDS = 30

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
PLUGIN_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,59}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


class ApiError(Exception):
    """An HTTP or transport failure. The message never contains the token."""


class Client:
    def __init__(self, base_url, token):
        base = base_url.rstrip("/")
        if base.endswith("/api"):
            base = base[: -len("/api")]
        self._base = base
        self._token = token

    def _scrub(self, text):
        return str(text).replace(self._token, "***") if self._token else str(text)

    def request(self, method, path, body=None):
        data = None
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self._base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as err:
            raise ApiError("%s %s failed: HTTP %s" % (method, path, err.code)) from None
        except Exception as err:  # URLError, timeout, ssl, ...
            raise ApiError(self._scrub("%s %s failed: %s" % (method, path, type(err).__name__))) from None
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError("%s %s returned invalid JSON" % (method, path)) from None


def parse_utc(value, label):
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError("%s must be an ISO 8601 time, got %r" % (label, value)) from None
    if parsed.tzinfo is None:
        raise ValueError("%s must carry a timezone (use Z for UTC)" % label)
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_args(args):
    if not ID_RE.match(args.deploy_id):
        raise ValueError("--deploy-id must be 1-80 chars of letters, digits, . _ : -")
    if not PLUGIN_RE.match(args.plugin):
        raise ValueError("--plugin must be a lowercase plugin name")
    if not VERSION_RE.match(args.version):
        raise ValueError("--version must look like x.y.z")
    if not SHA_RE.match(args.sha):
        raise ValueError("--sha must be 7-40 hex characters")
    if args.downtime_minutes < 0 or args.downtime_minutes > 1440:
        raise ValueError("--downtime-minutes must be between 0 and 1440")
    start = parse_utc(args.window_start, "--window-start")
    end = parse_utc(args.window_end, "--window-end")
    if end < start:
        raise ValueError("--window-end must not be before --window-start")
    return start, end


def build_marker(args, start, end):
    # Key order is part of the contract (readers use json.loads, but humans diff it).
    payload = {
        "id": args.deploy_id,
        "phase": args.phase,
        "plugin": args.plugin,
        "version": args.version,
        "reason": args.reason,
        "windowStartUtc": start,
        "windowEndUtc": end,
        "downtimeMinutes": args.downtime_minutes,
    }
    return MARKER_PREFIX + json.dumps(payload, separators=(",", ":")) + " -->"


def one_line(text, limit=200):
    return re.sub(r"\s+", " ", text).strip()[:limit]


def build_comment(args, start, end):
    what = "%s %s" % (args.plugin, args.version)
    reason = {
        "migration": "a database change",
        "capability": "a new permission",
        "both": "a database change and a new permission",
    }[args.reason]
    minutes = args.downtime_minutes
    window = "%s to %s (UTC)" % (start, end)
    short = args.sha[:7].lower()
    if args.phase == "planned":
        lines = [
            "Planned maintenance: %s needs a restart because of %s." % (what, reason),
            "When: during %s." % window,
            "Expected downtime: about %d minutes." % minutes,
            "No action needed.",
            "Release %s." % short,
        ]
    elif args.phase == "live":
        lines = [
            "Live: %s is released." % what,
            "Maintenance window was %s." % window,
            "Expected downtime was about %d minutes; things should be back to normal." % minutes,
            "No action needed.",
            "Release %s." % short,
        ]
    else:
        lines = [
            "Cancelled: the planned release of %s will not go ahead in the window above." % what,
            "Window was %s." % window,
            "No downtime from this release.",
            "No action needed.",
            "Release %s." % short,
        ]
    if args.summary:
        lines[0] = lines[0] + " " + one_line(args.summary)
    return build_marker(args, start, end) + "\n" + "\n".join(lines)


def parse_marker(body):
    """Return the marker dict for a v1 note, else None (unknown v / malformed = ignore)."""
    if not isinstance(body, str):
        return None
    match = MARKER_RE.match(body.split("\n", 1)[0])
    if not match or match.group(1) != "1":
        return None
    try:
        data = json.loads(match.group(2))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def as_list(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "data", "issues", "comments"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def resolve_companies(client, spec):
    if spec.strip().lower() != "all":
        ids = [part.strip() for part in spec.split(",") if part.strip()]
        if not ids:
            raise ValueError("--companies needs 'all' or a comma-separated id list")
        return list(dict.fromkeys(ids))
    ids = []
    for company in as_list(client.request("GET", "/api/companies")):
        if isinstance(company, dict) and company.get("id") and company.get("status") != "archived":
            ids.append(company["id"])
    return ids


def q(value):
    return urllib.parse.quote(value, safe="")


def process_company(client, company_id, args, comment, apply, out):
    """Returns 'posted' | 'would-post' | 'duplicate' | 'skipped'. Raises on failure."""
    origin = "cockpit:health:" + company_id
    found = as_list(client.request(
        "GET", "/api/companies/%s/issues?originId=%s&limit=5" % (q(company_id), q(origin))))
    matches = [i for i in found if isinstance(i, dict) and i.get("originId") == origin]
    if not found:
        print("WARNING %s: no System health issue, skipped" % company_id, file=out)
        return "skipped"
    if not matches:
        raise ApiError("health issue lookup returned issues with a different originId; refusing")
    issue_id = matches[0].get("id")
    if not issue_id:
        raise ApiError("health issue has no id")

    comments = as_list(client.request(
        "GET", "/api/issues/%s/comments?order=desc&limit=%d" % (q(issue_id), COMMENT_SCAN_LIMIT)))
    for existing in comments:
        marker = parse_marker(existing.get("body") if isinstance(existing, dict) else None)
        if marker and marker.get("id") == args.deploy_id and marker.get("phase") == args.phase:
            print("%s: already posted (%s/%s), nothing to do" % (company_id, args.deploy_id, args.phase), file=out)
            return "duplicate"

    if not apply:
        print("DRY RUN %s: would post to issue %s" % (company_id, matches[0].get("identifier") or issue_id), file=out)
        return "would-post"

    # Re-check the target right before the write.
    fresh = client.request("GET", "/api/issues/%s" % q(issue_id))
    if not isinstance(fresh, dict) or fresh.get("originId") != origin or fresh.get("companyId", company_id) != company_id:
        raise ApiError("issue %s originId/companyId mismatch; refusing to post" % issue_id)
    client.request("POST", "/api/issues/%s/comments" % q(issue_id), {"body": comment})
    print("POSTED %s: issue %s" % (company_id, matches[0].get("identifier") or issue_id), file=out)
    return "posted"


def run(args, client, out=None, err=None):
    out = out or sys.stdout
    err = err or sys.stderr
    try:
        start, end = validate_args(args)
        comment = build_comment(args, start, end)
        companies = resolve_companies(client, args.companies)
    except (ValueError, ApiError) as exc:
        print("error: %s" % exc, file=err)
        return 2
    print("%s: %s %s phase=%s deploy=%s, %d company(ies)" % (
        "APPLY" if args.apply else "DRY RUN", args.plugin, args.version, args.phase,
        args.deploy_id, len(companies)), file=out)
    print("--- comment text ---\n%s\n--- end ---" % comment, file=out)
    failed = []
    for company_id in companies:
        try:
            process_company(client, company_id, args, comment, args.apply, out)
        except (ApiError, ValueError) as exc:
            print("FAILED %s: %s" % (company_id, exc), file=err)
            failed.append(company_id)
    if failed:
        print("failed companies: %s" % ", ".join(failed), file=err)
        return 1
    return 0


def build_parser():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("phase", choices=PHASES)
    p.add_argument("--deploy-id", required=True)
    p.add_argument("--plugin", required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--reason", required=True, choices=REASONS)
    p.add_argument("--window-start", required=True)
    p.add_argument("--window-end", required=True)
    p.add_argument("--downtime-minutes", required=True, type=int)
    p.add_argument("--summary", default="")
    p.add_argument("--companies", required=True, help="'all' or comma-separated company ids")
    p.add_argument("--apply", action="store_true", help="post for real (default is a dry run)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    token = os.environ.get("PAPERCLIP_API_KEY", "")
    base = os.environ.get("PAPERCLIP_API_URL", "")
    if not token or not base:
        print("error: PAPERCLIP_API_KEY and PAPERCLIP_API_URL must be set", file=sys.stderr)
        return 2
    return run(args, Client(base, token))


if __name__ == "__main__":
    sys.exit(main())
