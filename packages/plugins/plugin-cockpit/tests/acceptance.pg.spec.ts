/**
 * Acceptance runs against a real Postgres (Q5-1, Q5-2): starting and working a
 * journey through the tools, what the Cockpit looks up itself, the report and the
 * failure issues, the canary's own approvals, the three ways a request opens
 * (nightly, a release, a person) and what the health checks say.
 */
import { pluginEvent, SETUP_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onSetupStatusEvent } from "../src/register.js";
import { ORIGIN } from "../src/constants.js";
import { JOBS } from "../src/constants.js";
import { acceptanceChecks, failureOriginPrefix, getRun, latestRuns, listRuns, nightlyAcceptance, openAcceptanceRequest, STALE_RUN_MS, sweepStaleRuns } from "../src/acceptance.js";
import { acceptanceAgentId } from "../src/acceptance-role.js";
import { journeyByKey, JOURNEYS } from "../src/journeys.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const REV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ACC = "aaaaaaaa-0000-4000-8000-0000000000a3";
const AM = "aaaaaaaa-0000-4000-8000-0000000000a4";
const OWNER = "user-owner";
const CANARY = "company:canary-1a2b3c4d";
const REAL = "company:6f1c2b0e-1111-4222-8333-444455556666";
const NOW = "2026-10-04T02:40:00.000Z";
const run = { agentId: ACC, runId: "r1", companyId: A, projectId: "p1" };
const userCtx = { companyId: A, actor: { type: "user", userId: OWNER } };

type ToolResult = { content: string; data: Record<string, any>; error?: string };

d("acceptance runs (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(options: { acceptance?: boolean; reviewOutward?: boolean; reviewer?: boolean } = {}) {
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: REV, companyId: A, name: "Rex", status: "idle", role: "general" },
          { id: ACC, companyId: A, name: "Acceptance", status: "idle", role: "qa" },
          { id: AM, companyId: A, name: "Account Manager", status: "idle", role: "general" },
        ],
      },
      NOW,
    );
    w.env.statFile = async (path) => (path.endsWith("missing.png") ? null : path.endsWith("tiny.png") ? { size: 500 } : path.endsWith("huge.png") ? { size: 13 * 1024 * 1024 } : { size: 8000 });
    await saveTeam(w.env, A, { operatorAgentId: OP, ...(options.reviewer === false ? {} : { reviewerAgentId: REV }), reviewOutward: options.reviewOutward ?? true }, OWNER);
    if (options.acceptance !== false) await w.actions.get("cockpit.link-agent")!({ role: "acceptance", agentId: ACC }, userCtx);
    return w;
  }

  const call = async (w: Hybrid, name: string, params: Record<string, unknown>): Promise<ToolResult> => (await w.tools.get(name)!(params, run)) as ToolResult;
  /**
   * Calls the tool. The real create-canary-client echoes the run id the step asked it to pass (`runRef`), so a faithful agent's
   * answer for step 1 carries it; the helper adds it unless the test sets its own (a stale answer is tested explicitly).
   */
  const acceptanceRun = (w: Hybrid, params: Record<string, unknown>) => {
    const step1 = params.action === "record" && params.stepId === "ensure-canary";
    const withRef = step1 && params.output && typeof params.output === "object" && !("runRef" in (params.output as object));
    const emptyInput = step1 && (!params.input || (typeof params.input === "object" && Object.keys(params.input as object).length === 0));
    return call(w, "acceptance-run", step1 ? { ...params, ...(withRef ? { output: { ...(params.output as object), runRef: params.runId } } : {}), ...(emptyInput ? { input: { runRef: params.runId } } : {}) } : params);
  };

  /** The request issue the Acceptance agent is woken on. */
  const requestIssue = (w: Hybrid, id = "issue-req"): string => {
    w.issues.set(id, { id, companyId: A, title: "Acceptance request", description: "", status: "todo", assigneeAgentId: ACC, identifier: "PAR-950" });
    return id;
  };

  /** A closed lead issue about the canary, for the check step. */
  const leadIssue = (w: Hybrid, over: Record<string, unknown> = {}): string => {
    w.issues.set("issue-lead", { id: "issue-lead", companyId: A, title: "New lead: canary rehearsal", description: "From the canary form", status: "done", assigneeAgentId: AM, identifier: "PAR-951", ...over });
    return "issue-lead";
  };

  /** Minutes after NOW, the moment every run in these tests starts (a test moves the clock on to end a run later). */
  const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
  let strays = 0;
  /**
   * An open issue a rehearsal left behind: by default a plugin's task for the owner named after the fake client, made five minutes into the run.
   * It is in the host's issues table (what the net reads) and in the fake host (what it cancels through).
   */
  const strayIssue = async (w: Hybrid, title: string, over: Record<string, unknown> = {}): Promise<string> => {
    strays += 1;
    const id = `00000000-0000-4000-8000-${String(strays).padStart(12, "0")}`;
    const row = { id, companyId: A, title, description: "", status: "todo", assigneeUserId: OWNER, identifier: `PAR-${970 + strays}`, originKind: "plugin:partnersinbiz.seo:task", createdAt: at(5), ...over };
    w.issues.set(id, row);
    await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, row.companyId, row.identifier, row.title, row.description, row.status, row.originKind ?? null, row.createdAt]);
    return id;
  };
  const strayIssues = async (w: Hybrid, specs: Array<[string, Record<string, unknown>?]>): Promise<string[]> => {
    const ids: string[] = [];
    for (const [title, over] of specs) ids.push(await strayIssue(w, title, over));
    return ids;
  };

  /** What each lead-capture step returns when the product works. */
  const good = (leadId: string): Record<string, unknown> => ({
    "ensure-canary": { client: CANARY, contact: { ref: "contact:canary-contact-1a2b3c4d", email: "canary@canary.invalid" }, leadForm: { embed: { curl: "curl -sS -X POST 'https://paperclip.example/api/lead' -d '{\"email\":\"jane@example.com\"}'", example: "https://paperclip.example/_plugins/u/ui/lead-example.html" } }, rules: ["draft only"] },
    "look-at-the-form": { ok: true, bytes: 8000, path: "/tmp/pib-shots/form.png" },
    "count-leads-before": { sources: [{ canary: true, accepted: 3 }] },
    "send-test-enquiry": { status: 200, body: { ok: true } },
    "confirm-lead-arrived": { sources: [{ accepted: 4 }] },
    "qualify-note": { id: "a1", recordType: "contact", recordId: "canary-contact-1a2b3c4d", kind: "note" },
    "mark-prospect": { lifecycle: "prospect" },
    "close-lead-issue": { issueId: leadId },
    cleanup: { cleaned: true, company: CANARY },
  });

  /** The input the agent reports for each step: what it was given, with the curl's example address changed. */
  const inputFor = (step: Record<string, any>): unknown => {
    const input = step.input ?? {};
    if (typeof input.curl === "string") return { curl: input.curl.replace("jane@example.com", "canary@canary.invalid") };
    return input;
  };

  const evidenceFor = (step: Record<string, any>) => [
    ...(step.attach?.includes("curl") ? [{ kind: "curl", ref: "curl -sS -X POST ... (canary address)" }] : []),
    ...(step.attach?.includes("screenshot") ? [{ kind: "screenshot", ref: "/tmp/pib-shots/form.png", note: "desktop" }, { kind: "screenshot", ref: "/tmp/pib-shots/form-mobile.png", note: "mobile" }] : []),
  ];

  /** Starts a journey and records every step with the given outputs (a step with `error` set reports it). `afterStart` runs once the run is open (the host does things while a run is open). */
  async function work(w: Hybrid, key: string, outputs: Record<string, unknown>, options: { issueId?: string | null; errors?: Record<string, string>; stopAfter?: string; afterStart?: () => void | Promise<void> } = {}) {
    const started = await acceptanceRun(w, { action: "start", journey: key, client: CANARY, ...(options.issueId ? { issueId: options.issueId } : {}) });
    expect(started.error, started.content).toBeUndefined();
    const runId = started.data.runId as string;
    await options.afterStart?.();
    let step = started.data.step as Record<string, any> | null;
    let last: ToolResult = started;
    while (step) {
      const error = options.errors?.[step.id];
      last = await acceptanceRun(w, { action: "record", runId, stepId: step.id, input: inputFor(step), ...(error ? { error } : { output: outputs[step.id] }), evidence: evidenceFor(step) });
      expect(last.error, last.content).toBeUndefined();
      if (options.stopAfter === step.id) break;
      step = last.data.finished ? null : (last.data.step as Record<string, any> | null);
    }
    return { runId, last };
  }

  describe("starting a run", () => {
    it("starts only on the canary client, and says what the first step is", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      expect(started.error).toBeUndefined();
      expect(started.data.step).toMatchObject({ id: "ensure-canary", number: "1/9", tool: "partnersinbiz.crm:create-canary-client" });
      expect(started.data.step.mustShow).toContain(`client is "${CANARY}"`);
      expect(started.data.step.then).toContain("acceptance-run");
      const row = await getRun(w.ctx, A, started.data.runId);
      expect(row).toMatchObject({ journeyKey: "lead-capture", clientRef: CANARY, status: "running", trigger: "on-demand" });
    });

    it("refuses a real client, an unknown journey, a missing client and an issue that is not there", async () => {
      const w = await make();
      expect((await acceptanceRun(w, { action: "start", journey: "lead-capture", client: REAL })).error).toContain("only on the canary client");
      expect((await acceptanceRun(w, { action: "start", journey: "lead-capture", client: "contact:canary-1a2b3c4d" })).error).toContain("only on the canary client");
      expect((await acceptanceRun(w, { action: "start", journey: "ghost", client: CANARY })).error).toContain("There is no journey");
      expect((await acceptanceRun(w, { action: "start", journey: "lead-capture" })).error).toContain("needs journey and client");
      expect((await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY, issueId: "PAR-404" })).error).toContain("was not found");
      expect(await listRuns(w.ctx, A)).toEqual([]);
    });

    it("refuses a second run while one is open, of any journey (they share one canary client), and aborts a stale one", async () => {
      const w = await make();
      const first = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      const again = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      expect(again.error).toContain(`Run ${first.data.runId} of lead-capture is still open`);
      // Another journey would lose the canary when the first one's cleanup removes it (the first live three-journey request did exactly that).
      const other = await acceptanceRun(w, { action: "start", journey: "seo-sprint-draft", client: CANARY });
      expect(other.error).toContain(`Run ${first.data.runId} of lead-capture is still open`);
      expect(other.error).toContain("Journeys run one at a time");
      expect(other.error).toContain("then start seo-sprint-draft");
      // Once the first is over, the other journey starts.
      await acceptanceRun(w, { action: "abort", runId: first.data.runId, reason: "test" });
      expect((await acceptanceRun(w, { action: "start", journey: "seo-sprint-draft", client: CANARY })).error).toBeUndefined();
      // Nobody touched the other run for over two hours: the next start aborts it and goes ahead.
      w.clock.set(new Date(Date.parse(NOW) + STALE_RUN_MS + 60_000).toISOString());
      const fresh = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      expect(fresh.error).toBeUndefined();
      expect((await listRuns(w.ctx, A, { journey: "seo-sprint-draft" }))[0]!.status).toBe("aborted");
      expect((await getRun(w.ctx, A, first.data.runId))!.status).toBe("aborted");
    });

    it("takes the trigger from the request issue it was woken on", async () => {
      const w = await make();
      const issueId = requestIssue(w);
      await w.client.query(`INSERT INTO ${(await import("../src/namespace.js")).NAMESPACE}.acceptance_requests (company_id, request_key, trigger, issue_id) VALUES ($1, 'release:partnersinbiz.crm:0.13.0', 'release', $2)`, [A, issueId]);
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY, issueId });
      expect(await getRun(w.ctx, A, started.data.runId)).toMatchObject({ trigger: "release", triggerRef: "release:partnersinbiz.crm:0.13.0", requestIssueId: issueId });
    });

    it("lists the journeys and the recent runs, and shows the step again", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      const listed = await acceptanceRun(w, { action: "list" });
      expect(listed.data.journeys.map((j: { key: string }) => j.key)).toEqual(JOURNEYS.map((j) => j.key));
      expect(listed.data.recent[0]).toMatchObject({ runId: started.data.runId, status: "running" });
      const next = await acceptanceRun(w, { action: "next", runId: started.data.runId });
      expect(next.data.step.id).toBe("ensure-canary");
    });
  });

  describe("a run that passes", () => {
    it("works every step, writes the report on the request issue and opens nothing else", async () => {
      const w = await make();
      const issueId = requestIssue(w);
      const lead = leadIssue(w);
      const { runId, last } = await work(w, "lead-capture", good(lead), { issueId });
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      expect(last.content).toContain("The run is finished");
      const row = (await getRun(w.ctx, A, runId))!;
      expect(row).toMatchObject({ status: "passed", summary: "Passed: 9 of 9 steps.", reportIssueId: issueId, children: {} });
      expect(row.finishedAt).not.toBeNull();
      const comment = w.comments.find((c) => c.issueId === issueId)!;
      expect(comment.body).toContain("PASSED");
      expect(comment.body).toContain("9 of 9 steps passed");
      expect(comment.body).toContain("### Evidence");
      expect(comment.body).toContain("screenshot /tmp/pib-shots/form.png");
      // A quiet nightly pass opens no issue and adds nothing to the owner's feed.
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toEqual([]);
      expect(await w.client.query(`SELECT key FROM ${(await import("../src/namespace.js")).NAMESPACE}.activity`).then((r) => r.rows)).toEqual([]);
    });

    it("a captured number carries from one step to the next (the form must count the new enquiry)", async () => {
      const w = await make();
      const lead = leadIssue(w);
      const stale = { ...good(lead), "confirm-lead-arrived": { sources: [{ accepted: 3 }] } };
      const { last } = await work(w, "lead-capture", stale, { issueId: requestIssue(w) });
      expect(last.data.status).toBe("failed");
      const row = (await getRun(w.ctx, A, last.data.runId))!;
      const failed = row.state.steps.find((s) => s.status === "failed")!;
      expect(failed.id).toBe("confirm-lead-arrived");
      expect(failed.checks.some((c) => !c.ok && c.detail.includes("above acceptedBefore"))).toBe(true);
    });
  });

  describe("a run that fails", () => {
    it("blocks the steps after it, still cleans up, and opens an issue for the owning role under the report", async () => {
      const w = await make();
      const issueId = requestIssue(w);
      const lead = leadIssue(w);
      const bad = { ...good(lead), "mark-prospect": { lifecycle: "lead" } };
      const { runId, last } = await work(w, "lead-capture", bad, { issueId });
      expect(last.data).toMatchObject({ finished: true, status: "failed" });
      const row = (await getRun(w.ctx, A, runId))!;
      expect(row.state.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed", "passed", "failed", "blocked", "passed"]);
      // One failure issue, a child of the request, for the role that owns the step (the Account Manager is not staffed: the Operator).
      const children = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ title: "Acceptance failure: Lead captured and qualified, Set the contact to prospect", parentId: issueId, assigneeAgentId: OP, priority: "high" });
      expect(children[0]!.description).toContain("lifecycle");
      expect(w.wakeups).toContain(children[0]!.id);
      expect(row.children["mark-prospect"]).toBe(`/PAR/issues/${children[0]!.id}`);
      expect(w.comments.find((c) => c.issueId === issueId)!.body).toContain("**Set the contact to prospect** (owner: account-manager)");
      expect(row.summary).toBe("Failed at Set the contact to prospect.");
    });

    it("with no request issue a failure opens its own report issue for the Operator; a pass would not", async () => {
      const w = await make();
      const lead = leadIssue(w);
      const { runId } = await work(w, "lead-capture", { ...good(lead), "send-test-enquiry": { status: 500, body: "boom" } });
      const row = (await getRun(w.ctx, A, runId))!;
      const report = w.issues.get(row.reportIssueId!)!;
      expect(report).toMatchObject({ title: "Acceptance failed: Lead captured and qualified", assigneeAgentId: OP, priority: "high" });
      expect(w.comments.find((c) => c.issueId === report.id)!.body).toContain("FAILED");
      const child = [...w.issues.values()].find((i) => i.originId?.includes(":fail:"))!;
      expect(child.parentId).toBe(report.id);
      expect(await w.client.query(`SELECT text FROM ${(await import("../src/namespace.js")).NAMESPACE}.activity WHERE kind = 'acceptance'`).then((r) => r.rows.map((x: any) => x.text))).toEqual(["Acceptance failed: Lead captured and qualified"]);
    });

    it("routes a failure to the role's own agent when it is staffed, and re-filing never opens a second issue", async () => {
      const w = await make();
      const lead = leadIssue(w);
      // The kit's routing reads each role's agent from the plugins' reports: say the Account Manager is staffed.
      const key = { scopeKind: "company", scopeId: A, namespace: "pib-cockpit", stateKey: "roles" };
      const roles = (await w.ctx.state.get(key as never)) as Record<string, unknown>;
      await w.ctx.state.set(key as never, { ...roles, team: { ...(roles.team as object), "account-manager": { agentId: AM, status: "idle" } } });
      await w.client.query(`INSERT INTO ${(await import("../src/namespace.js")).NAMESPACE}.snapshots (company_id, plugin_key, kind, payload, checked_at) VALUES ($1, 'partnersinbiz.crm', 'cockpit', $2::jsonb, $3)`, [A, JSON.stringify({ plugin: "partnersinbiz.crm", title: "CRM", checkedAt: NOW, kpis: [], health: [], waiting: [], activity: [], quality: [], team: [{ role: "account-manager", agentId: AM, status: "idle" }] }), NOW]);
      const { runId } = await work(w, "lead-capture", { ...good(lead), "qualify-note": { id: "a1", recordId: "wrong" } });
      const child = [...w.issues.values()].find((i) => i.originKind === ORIGIN.acceptance && i.originId?.includes(":fail:"))!;
      expect(child.assigneeAgentId).toBe(AM);
      const before = [...w.issues.values()].length;
      const filed = await call(w, "acceptance-report", { runId, file: true });
      expect(filed.data.refiled).toBe(false);
      expect([...w.issues.values()].length).toBe(before);
    });

    describe("a step that keeps failing", () => {
      const failures = (w: Hybrid) => [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance && i.originId?.includes(":fail:"));
      const NIGHT2 = "2026-10-05T02:40:00.000Z";
      const NIGHT3 = "2026-10-06T02:40:00.000Z";

      it("is one open issue with a comment per night, not a new issue and a new wake-up every night", async () => {
        const w = await make();
        const bad = { ...good(leadIssue(w)), "mark-prospect": { lifecycle: "lead" } };
        await work(w, "lead-capture", bad, { issueId: requestIssue(w, "issue-req") });
        expect(failures(w)).toHaveLength(1);
        const issue = failures(w)[0]!;
        expect(issue.originId).toMatch(new RegExp(`^${failureOriginPrefix("lead-capture", "mark-prospect")}run[0-9a-f]+$`));
        expect(w.wakeups.filter((x) => x === issue.id)).toHaveLength(1);
        w.clock.set(NIGHT2);
        const second = await work(w, "lead-capture", bad, { issueId: requestIssue(w, "issue-req2") });
        w.clock.set(NIGHT3);
        const third = await work(w, "lead-capture", bad, { issueId: requestIssue(w, "issue-req3") });
        // Still one issue, woken once; each later night left a comment saying so.
        expect(failures(w)).toHaveLength(1);
        expect(w.wakeups.filter((x) => x === issue.id)).toHaveLength(1);
        const repeats = w.comments.filter((c) => c.issueId === issue.id);
        expect(repeats).toHaveLength(2);
        expect(repeats[0]!.body).toContain(`Failed again in acceptance run \`${second.runId}\` (2026-10-05)`);
        expect(repeats[1]!.body).toContain(`Failed again in acceptance run \`${third.runId}\` (2026-10-06)`);
        expect(repeats[0]!.body).toContain("lifecycle");
        // Each night's own report still points at the one issue.
        expect((await getRun(w.ctx, A, second.runId))!.children["mark-prospect"]).toBe(`/PAR/issues/${issue.id}`);
        expect(w.comments.find((c) => c.issueId === "issue-req2")!.body).toContain(issue.id);
      });

      it("a new issue opens for a different failing step, for the same step once its issue is closed, and never across companies' journeys", async () => {
        const w = await make();
        const lead = leadIssue(w);
        const bad = { ...good(lead), "mark-prospect": { lifecycle: "lead" } };
        await work(w, "lead-capture", bad, { issueId: requestIssue(w, "issue-req") });
        const first = failures(w)[0]!;
        // Closed: the next failure of the same step is a new problem.
        w.issues.get(first.id)!.status = "done";
        w.clock.set(NIGHT2);
        await work(w, "lead-capture", bad, { issueId: requestIssue(w, "issue-req2") });
        expect(failures(w)).toHaveLength(2);
        const second = failures(w).find((i) => i.id !== first.id)!;
        // A different step failing while the second is open is its own issue, and the second gets no comment for it.
        w.clock.set(NIGHT3);
        await work(w, "lead-capture", { ...good(lead), "qualify-note": { id: "a1", recordId: "wrong" } }, { issueId: requestIssue(w, "issue-req3") });
        expect(failures(w)).toHaveLength(3);
        expect(w.comments.filter((c) => c.issueId === second.id)).toHaveLength(0);
        expect(failures(w).map((i) => i.title).sort()[0]).toContain("Acceptance failure");
      });

      it("another journey's open failure with the same step name is not a repeat", async () => {
        const w = await make();
        expect(failureOriginPrefix("lead-capture", "cleanup")).not.toBe(failureOriginPrefix("quote-to-invoice", "cleanup"));
        expect(failureOriginPrefix("lead-capture", "mark")).not.toBe(failureOriginPrefix("lead-capture", "mark-prospect"));
        // An open failure of another journey, and of another step of this one, both with look-alike names.
        for (const [id, journey, step] of [["other-journey", "quote-to-invoice", "mark-prospect"], ["other-step", "lead-capture", "mark"]] as const) {
          w.issues.set(id, { id, companyId: A, title: "Acceptance failure: elsewhere", description: "", status: "todo", originKind: ORIGIN.acceptance, originId: `${failureOriginPrefix(journey, step)}runold`, identifier: `PAR-97${id.length}` });
        }
        await work(w, "lead-capture", { ...good(leadIssue(w)), "mark-prospect": { lifecycle: "lead" } }, {});
        expect(failures(w)).toHaveLength(3);
        expect(w.comments.filter((c) => c.issueId === "other-journey" || c.issueId === "other-step")).toEqual([]);
      });
    });

    it("an error the step reports fails it, and the agent is not told to retry", async () => {
      const w = await make();
      const { last } = await work(w, "lead-capture", good(leadIssue(w)), { errors: { "ensure-canary": "No lead form: open the CRM page once" } });
      expect(last.data.status).toBe("failed");
      const row = (await getRun(w.ctx, A, last.data.runId))!;
      expect(row.state.steps[0]!.checks[0]!.detail).toContain("reported an error: No lead form");
    });
  });

  describe("what the Cockpit checks itself", () => {
    it("fails a check step whose issue is still open, or is not about the canary", async () => {
      const w = await make();
      const open = leadIssue(w, { status: "todo" });
      const first = await work(w, "lead-capture", good(open), {});
      expect((await getRun(w.ctx, A, first.runId))!.state.steps.find((s) => s.id === "close-lead-issue")).toMatchObject({ status: "failed" });
      const w2 = await make();
      const real = leadIssue(w2, { title: "New lead: Agri Studies", description: "A real client's enquiry" });
      const second = await work(w2, "lead-capture", good(real), {});
      expect((await getRun(w2.ctx, A, second.runId))!.state.steps.find((s) => s.id === "close-lead-issue")!.checks.some((c) => !c.ok && c.detail.includes("matches canary"))).toBe(true);
      const w3 = await make();
      const gone = await work(w3, "lead-capture", good("no-such-issue"), {});
      expect((await getRun(w3.ctx, A, gone.runId))!.state.steps.find((s) => s.id === "close-lead-issue")!.checks.some((c) => !c.ok && c.detail.includes("could not be found"))).toBe(true);
    });

    it("fails step 1 when the answer is not this run's own: a stale answer from an earlier call or journey is refused", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      expect(started.data.step.input).toEqual({ runRef: started.data.runId });
      const stale = await acceptanceRun(w, { action: "record", runId: started.data.runId, stepId: "ensure-canary", input: { runRef: started.data.runId }, output: { ...(good("x")["ensure-canary"] as object), runRef: "run-from-the-previous-journey" } });
      expect(stale.data.result.status).toBe("failed");
      expect(stale.data.result.checks.join("\n")).toContain("runRef");
      const w2 = await make();
      const s2 = await acceptanceRun(w2, { action: "start", journey: "lead-capture", client: CANARY });
      const missing = await acceptanceRun(w2, { action: "record", runId: s2.data.runId, stepId: "ensure-canary", input: {}, output: { ...(good("x")["ensure-canary"] as object), runRef: undefined } });
      expect(missing.data.result.status).toBe("failed");
    });

    it("reads an evidence item's file under the names an agent naturally uses, and says when an item was ignored", async () => {
      // The first live run lost its screenshots to `path` instead of `ref`: the step failed with no hint why.
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      await acceptanceRun(w, { action: "record", runId: started.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      const viaPath = await acceptanceRun(w, { action: "record", runId: started.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", path: "/tmp/pib-shots/by-path-missing.png" }] });
      // Read as the file (so the Cockpit went looking for it on disk), not dropped as an item without a ref.
      expect(viaPath.data.result.checks.join("\n")).toContain("by-path-missing.png was not found on disk");
      expect(viaPath.data.result.checks.join("\n")).not.toContain("were ignored");
      const w2 = await make();
      const s2 = await acceptanceRun(w2, { action: "start", journey: "lead-capture", client: CANARY });
      await acceptanceRun(w2, { action: "record", runId: s2.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      const unreadable = await acceptanceRun(w2, { action: "record", runId: s2.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", note: "no file given" }, { kind: "bogus", ref: "x" }] });
      expect(unreadable.data.result.status).toBe("failed");
      expect(unreadable.data.result.checks.join("\n")).toContain("No screenshot evidence attached (2 item(s) you sent were ignored");
    });

    it("fails a screenshot that is not on disk, and one that is outside the folders agents write", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      const ensure = await acceptanceRun(w, { action: "record", runId: started.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      expect(ensure.data.step.id).toBe("look-at-the-form");
      const missing = await acceptanceRun(w, { action: "record", runId: started.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", ref: "/tmp/pib-shots/missing.png" }] });
      expect(missing.data.result.status).toBe("failed");
      expect(missing.data.result.checks.join("\n")).toContain("missing.png was not found on disk");
      for (const file of ["tiny.png", "huge.png"]) {
        const sized = await make();
        const s0 = await acceptanceRun(sized, { action: "start", journey: "lead-capture", client: CANARY });
        await acceptanceRun(sized, { action: "record", runId: s0.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
        const odd = await acceptanceRun(sized, { action: "record", runId: s0.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", ref: `/tmp/pib-shots/${file}` }] });
        expect(odd.data.result.status, file).toBe("failed");
      }
      const w2 = await make();
      const s2 = await acceptanceRun(w2, { action: "start", journey: "lead-capture", client: CANARY });
      await acceptanceRun(w2, { action: "record", runId: s2.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      const outside = await acceptanceRun(w2, { action: "record", runId: s2.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", ref: "/etc/passwd.png" }] });
      expect(outside.data.result.status).toBe("failed");
      const traversal = await make();
      const s3 = await acceptanceRun(traversal, { action: "start", journey: "lead-capture", client: CANARY });
      await acceptanceRun(traversal, { action: "record", runId: s3.data.runId, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      const dots = await acceptanceRun(traversal, { action: "record", runId: s3.data.runId, stepId: "look-at-the-form", input: { url: "https://paperclip.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", ref: "/tmp/../etc/shadow.png" }] });
      expect(dots.data.result.status).toBe("failed");
    });

    it("fails a call recorded without its input (nothing to check is not nothing wrong), and keeps no raw secret from the input it was given", async () => {
      const w = await make();
      const lead = leadIssue(w);
      const { runId } = await work(w, "lead-capture", good(lead), { stopAfter: "look-at-the-form" });
      const bare = await acceptanceRun(w, { action: "record", runId, stepId: "count-leads-before", output: good(lead)["count-leads-before"] });
      expect(bare.data.result.status).toBe("failed");
      const row = (await getRun(w.ctx, A, runId))!;
      expect(row.state.steps.find((s) => s.id === "count-leads-before")!.checks.some((c) => !c.ok && c.detail.includes("No input was reported"))).toBe(true);
      expect(row.state.abortReason).toBeFalsy();
      // Another run: the input is given, with a credential in it. The run keeps the redacted copy only.
      const w2 = await make();
      const again = await work(w2, "lead-capture", good(leadIssue(w2)), { stopAfter: "look-at-the-form" });
      const secret = "sk-live-abcdefghijklmnopqrstuvwx";
      const shown = await acceptanceRun(w2, { action: "record", runId: again.runId, stepId: "count-leads-before", input: { client: CANARY, apiKey: secret, note: "x".repeat(4000) }, output: good(leadIssue(w2))["count-leads-before"] });
      expect(shown.error).toBeUndefined();
      const stored = await w2.client.query(`SELECT state::text AS state FROM ${NAMESPACE}.acceptance_runs WHERE id = $1`, [again.runId]).then((r) => String((r.rows[0] as { state: string }).state));
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain("x".repeat(2000));
      expect(stored).toContain("[redacted]");
    });

    it("aborts the run when the agent reports a real address, and records nothing after it", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY, issueId: requestIssue(w) });
      const id = started.data.runId as string;
      await acceptanceRun(w, { action: "record", runId: id, stepId: "ensure-canary", input: {}, output: good("x")["ensure-canary"] });
      await acceptanceRun(w, { action: "record", runId: id, stepId: "look-at-the-form", input: { url: "https://p.example/x" }, output: { ok: true, bytes: 8000 }, evidence: [{ kind: "screenshot", ref: "/tmp/a.png" }] });
      await acceptanceRun(w, { action: "record", runId: id, stepId: "count-leads-before", input: { client: CANARY }, output: good("x")["count-leads-before"] });
      const touched = await acceptanceRun(w, { action: "record", runId: id, stepId: "send-test-enquiry", input: { curl: "curl -d '{\"email\":\"ceo@agristudies.co.za\"}'" }, output: { status: 200 }, evidence: [{ kind: "curl", ref: "curl" }] });
      expect(touched.data).toMatchObject({ finished: true, status: "aborted" });
      const row = (await getRun(w.ctx, A, id))!;
      expect(row.status).toBe("aborted");
      expect(row.state.abortReason).toContain("ceo@agristudies.co.za");
      expect((await acceptanceRun(w, { action: "record", runId: id, stepId: "confirm-lead-arrived", input: {}, output: {} })).error).toContain("already aborted");
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain("ABORTED (not a pass)");
    });

    it("an abort by the agent is not a pass and not a failure issue", async () => {
      const w = await make();
      const started = await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY });
      const aborted = await acceptanceRun(w, { action: "abort", runId: started.data.runId, reason: "the CRM module is switched off" });
      expect(aborted.data).toMatchObject({ status: "aborted", summary: "Aborted: the CRM module is switched off" });
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance && i.originId?.includes(":fail:"))).toEqual([]);
    });
  });

  describe("approvals the journeys open", () => {
    const sequenceOutputs = (approvalId: string): Record<string, unknown> => ({
      "ensure-canary": { client: CANARY, contact: { ref: "contact:canary-contact-1a2b3c4d", email: "canary@canary.invalid" } },
      "create-email-sequence": { id: "seq-1", name: "Canary acceptance", delivery: "email", emailApproved: false, approvalIssueId: approvalId },
      "enroll-canary-contact": { id: "enr-1", status: "running" },
      cleanup: { cleaned: true, company: CANARY },
    });
    const approval = (w: Hybrid, over: Record<string, unknown> = {}) => {
      w.issues.set("issue-appr", { id: "issue-appr", companyId: A, title: "Approve email sending: Canary acceptance", description: `Sequence for ${CANARY} (PiB Canary Co)`, status: "todo", assigneeAgentId: REV, identifier: "PAR-960", originKind: "plugin:partnersinbiz.crm", ...over });
      return "issue-appr";
    };

    it("passes when an outward approval reached the Reviewer, then cancels the canary's own approval", async () => {
      const w = await make();
      const id = approval(w);
      const { runId, last } = await work(w, "email-sequence-dry-run", sequenceOutputs(id), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect(w.issues.get(id)!.status).toBe("cancelled");
      expect(w.comments.find((c) => c.issueId === id)!.body).toContain(`Cancelled by acceptance run ${runId}`);
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain("The canary's own approval was cancelled (1): nothing was sent.");
      // The activity line says a release was checked only for a release; this was on demand.
    });

    it("fails when the approval opened with nobody assigned (the 2026-10-01 cold-email bug)", async () => {
      const w = await make();
      const id = approval(w, { assigneeAgentId: null, assigneeUserId: null });
      const { last } = await work(w, "email-sequence-dry-run", sequenceOutputs(id), {});
      expect(last.data.status).toBe("failed");
      const row = (await getRun(w.ctx, A, last.data.runId))!;
      expect(row.state.steps.find((s) => s.id === "create-email-sequence")!.checks.some((c) => !c.ok && c.detail.includes("nobody assigned"))).toBe(true);
    });

    it("fails when outward work went to the owner and skipped the Reviewer, but not when the company does not review", async () => {
      const w = await make();
      const id = approval(w, { assigneeAgentId: null, assigneeUserId: OWNER });
      expect((await work(w, "email-sequence-dry-run", sequenceOutputs(id), {})).last.data.status).toBe("failed");
      const w2 = await make({ reviewOutward: false });
      const id2 = approval(w2, { assigneeAgentId: null, assigneeUserId: OWNER });
      expect((await work(w2, "email-sequence-dry-run", sequenceOutputs(id2), {})).last.data.status).toBe("passed");
    });

    it("leaves an approval open that does not name the canary, and says so", async () => {
      const w = await make();
      const id = approval(w, { title: "Approve email sending: Q4 reactivation", description: "A real client's sequence" });
      const { last } = await work(w, "email-sequence-dry-run", sequenceOutputs(id), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect(w.issues.get(id)!.status).toBe("todo");
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain(`Left open, because it does not name the canary: ${id}`);
    });
  });

  describe("the e-sign and site events journeys (0.6.0)", () => {
    const DOC = "7a1c0e2e-5b1d-4c53-9e55-0a6f2f0b9c11";
    const SHA = "a".repeat(64);
    const canaryClient = { client: CANARY, contact: { ref: "contact:canary-contact-1a2b3c4d", email: "canary@canary.invalid" }, leadForm: { embed: { example: "https://paperclip.example/_plugins/u/ui/lead-example.html", curl: "curl -sS -X POST 'https://paperclip.example/api/lead'" } }, rules: ["draft only"] };
    const approval = (w: Hybrid, over: Record<string, unknown> = {}) => {
      w.issues.set("issue-sign", { id: "issue-sign", companyId: A, title: "Approve signing link for PiB Canary Co: Acceptance rehearsal", description: `Document for ${CANARY}`, status: "todo", assigneeAgentId: REV, identifier: "PAR-961", originKind: "plugin:partnersinbiz.crm", ...over });
      return "issue-sign";
    };
    /** The work issue the CRM opens for a document the moment it is sent for signature (for the deal desk, in the canary's own words). */
    const workIssue = (w: Hybrid, over: Record<string, unknown> = {}) => {
      w.issues.set("issue-work", { id: "issue-work", companyId: A, title: "Get \"Proposal: Acceptance rehearsal r1\" signed by PiB Canary Co", description: `Prepared for PiB Canary Co to sign online (${CANARY}).`, status: "todo", assigneeAgentId: AM, identifier: "PAR-962", originKind: "plugin:partnersinbiz.crm", originId: `crm:esign:${DOC}`, ...over });
      return "issue-work";
    };
    /** What each e-sign step returns when the CRM works (the shapes the CRM's own tools return). */
    const esignOutputs = (approvalId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
      "ensure-canary": canaryClient,
      "create-document": { documentId: DOC, client: CANARY, kind: "proposal", title: "Acceptance rehearsal r1", status: "draft", to: "Canary Contact <canary@canary.invalid>", contentSha256: SHA, canary: true },
      "read-document": { documentId: DOC, client: CANARY, status: "draft", contentSha256: SHA, content: "# Proposal\n\nAcceptance rehearsal.", consentText: "I agree to sign this document electronically.", trailIntact: true, trail: [{ seq: 1, at: NOW, kind: "created", actor: "agent:acc" }] },
      "send-for-signature": { documentId: DOC, status: "awaiting_approval", approvalIssueId: approvalId, workIssueId: "issue-work" },
      "verify-record": { documentId: DOC, status: "awaiting_approval", ok: true, problems: [], events: 2, contentSha256: SHA, auditFingerprint: null },
      "list-documents": { count: 1, documents: [{ documentId: DOC, status: "awaiting_approval" }], esign: { allowed: true, canary: true, turnedOnBy: null } },
      withdraw: { documentId: DOC, status: "void", emailsWithdrawn: 1 },
      "confirm-withdrawn": { documentId: DOC, status: "void", statusLine: "Withdrawn on 4 Oct 2026: the rehearsal is finished.", trailIntact: true, trail: [] },
      cleanup: { cleaned: true, company: CANARY },
      ...over,
    });
    const eventsOutputs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      "ensure-canary": canaryClient,
      "make-key": { created: true, key: { id: "key-1", client: CANARY, canary: true, status: "active", writeKey: "pibe_example", install: { curl: "curl -sS -X POST 'https://paperclip.example/api/plugins/partnersinbiz.crm/webhooks/ev' -H 'content-type: application/json' -d '{}'", endpoint: "https://paperclip.example/api/plugins/partnersinbiz.crm/webhooks/ev" } } },
      "count-before": { keys: 1, entrances: 0, pageviews: 0 },
      "send-test-event": { status: 200, body: { status: "success" } },
      "confirm-counter-moved": { keys: 1, entrances: 1, pageviews: 1 },
      "key-counted": { keys: [{ id: "key-1", counted: 1, refused: 0, canary: true }] },
      "pause-key": { key: { id: "key-1", status: "paused" } },
      cleanup: { cleaned: true, company: CANARY },
      ...over,
    });
    const stepStatuses = async (w: Hybrid, runId: string) => Object.fromEntries((await getRun(w.ctx, A, runId))!.state.steps.map((st) => [st.id, st.status]));

    it("e-sign passes when the CRM works: the approval reached the Reviewer, and nothing is left waiting", async () => {
      const w = await make();
      const id = approval(w);
      const { runId, last } = await work(w, "esign", esignOutputs(id), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect((await getRun(w.ctx, A, runId))!.state.captures).toMatchObject({ documentId: DOC, contentSha256: SHA, contactId: "canary-contact-1a2b3c4d" });
      // The CRM's own void withdrew the approval in real life; here it is still open, so the Cockpit cancels it when the run ends.
      expect(w.issues.get(id)!.status).toBe("cancelled");
    });

    it("e-sign fails at the send, and still cleans up, when the CRM does not know its public address", async () => {
      const w = await make();
      const refusal = "Open the CRM page once so the plugin learns its public address, then ask again.";
      const { runId, last } = await work(w, "esign", esignOutputs("none"), { errors: { "send-for-signature": refusal } });
      expect(last.data.status).toBe("failed");
      expect(await stepStatuses(w, runId)).toMatchObject({ "create-document": "passed", "read-document": "passed", "send-for-signature": "failed", "verify-record": "blocked", withdraw: "blocked", cleanup: "passed" });
      const failure = (await getRun(w.ctx, A, runId))!.state.steps.find((st) => st.id === "send-for-signature")!;
      expect(failure.checks.some((c) => !c.ok && c.detail.includes("public address"))).toBe(true);
    });

    it("e-sign fails when a signing link shows up before anyone approved the email", async () => {
      const w = await make();
      const id = approval(w);
      const leak = esignOutputs(id, { "read-document": { ...(esignOutputs(id)["read-document"] as object), canaryLink: "https://paperclip.example/_plugins/u/ui/s/abc.html#token" } });
      const { runId, last } = await work(w, "esign", leak, {});
      expect(last.data.status).toBe("failed");
      expect((await stepStatuses(w, runId))["read-document"]).toBe("failed");
    });

    it("e-sign fails when the approval skipped the Reviewer, when the record is broken, and when the document is not the one it made", async () => {
      const w = await make();
      const skipped = approval(w, { assigneeAgentId: null, assigneeUserId: OWNER });
      expect((await stepStatuses(w, (await work(w, "esign", esignOutputs(skipped), {})).runId))["send-for-signature"]).toBe("failed");
      const w2 = await make();
      const ok = approval(w2);
      const broken = await work(w2, "esign", esignOutputs(ok, { "verify-record": { documentId: DOC, status: "awaiting_approval", ok: false, problems: ["The text of the document does not match its recorded SHA-256"], events: 2, contentSha256: SHA } }), {});
      expect((await stepStatuses(w2, broken.runId))["verify-record"]).toBe("failed");
      const w3 = await make();
      const id3 = approval(w3);
      const other = await work(w3, "esign", esignOutputs(id3, { "read-document": { ...(esignOutputs(id3)["read-document"] as object), contentSha256: "b".repeat(64) } }), {});
      expect((await stepStatuses(w3, other.runId))["read-document"]).toBe("failed");
    });

    it("e-sign: an approval the CRM already withdrew is not cancelled a second time", async () => {
      const w = await make();
      const id = approval(w, { status: "cancelled" });
      const { last } = await work(w, "esign", esignOutputs(id), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect(w.comments.filter((c) => c.issueId === id)).toEqual([]);
    });

    it("e-sign cancels the work issue the CRM opened for the document as well, so no agent is left waiting on a rehearsal, and the report says so", async () => {
      const w = await make();
      const id = approval(w);
      const work1 = workIssue(w);
      const { runId, last } = await work(w, "esign", esignOutputs(id), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect((await getRun(w.ctx, A, runId))!.state.rehearsalIssues).toEqual([work1]);
      expect(w.issues.get(work1)!.status).toBe("cancelled");
      expect(w.comments.find((c) => c.issueId === work1)!.body).toContain(`Cancelled by acceptance run ${runId}: this issue was opened for the canary client by a rehearsal`);
      const report = w.comments.find((c) => c.issueId === "issue-req")!.body;
      expect(report).toContain("The canary's own approval was cancelled (1)");
      expect(report).toContain("The work issue the rehearsal opened for the canary was cancelled (1)");
    });

    it("e-sign leaves a work issue that does not name the canary alone, and says it did", async () => {
      const w = await make();
      const id = approval(w);
      const work1 = workIssue(w, { title: "Get the Q4 agreement signed", description: "A real client's document" });
      await work(w, "esign", esignOutputs(id), { issueId: requestIssue(w) });
      expect(w.issues.get(work1)!.status).toBe("todo");
      expect(w.comments.filter((c) => c.issueId === work1)).toEqual([]);
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain(`Left open, because it does not name the canary: ${work1}`);
    });

    it("e-sign cancels the work issue even when the send step then fails (the approval skipped the Reviewer): it exists either way", async () => {
      const w = await make();
      const skipped = approval(w, { assigneeAgentId: null, assigneeUserId: OWNER });
      const work1 = workIssue(w);
      const { runId } = await work(w, "esign", esignOutputs(skipped), {});
      expect((await stepStatuses(w, runId))["send-for-signature"]).toBe("failed");
      expect(w.issues.get(work1)!.status).toBe("cancelled");
    });

    it("e-sign remembers no work issue from a send that errored, so nothing it did not open is touched", async () => {
      const w = await make();
      const work1 = workIssue(w);
      const { runId } = await work(w, "esign", esignOutputs("none"), { errors: { "send-for-signature": "Open the CRM page once so the plugin learns its public address." } });
      expect((await getRun(w.ctx, A, runId))!.state.rehearsalIssues).toBeUndefined();
      expect(w.issues.get(work1)!.status).toBe("todo");
    });

    it("a send that reported an error, or aborted the run for using something that is not the canary, remembers no issue even if its answer names one", async () => {
      const w = await make();
      const id = approval(w);
      const work1 = workIssue(w);
      const outputs = esignOutputs(id);
      const started = await work(w, "esign", outputs, { stopAfter: "read-document" });
      const errored = await acceptanceRun(w, { action: "record", runId: started.runId, stepId: "send-for-signature", input: { documentId: DOC }, error: "The CRM answered 500", output: outputs["send-for-signature"] });
      expect(errored.data.result.status).toBe("failed");
      expect((await getRun(w.ctx, A, started.runId))!.state.rehearsalIssues).toBeUndefined();

      const w2 = await make();
      const id2 = approval(w2);
      const work2 = workIssue(w2);
      const outputs2 = esignOutputs(id2);
      const second = await work(w2, "esign", outputs2, { stopAfter: "read-document" });
      const touched = await acceptanceRun(w2, { action: "record", runId: second.runId, stepId: "send-for-signature", input: { documentId: DOC, contactId: "contact-of-a-real-client" }, output: outputs2["send-for-signature"] });
      expect(touched.data).toMatchObject({ finished: true, status: "aborted" });
      expect((await getRun(w2.ctx, A, second.runId))!.state.rehearsalIssues).toBeUndefined();
      expect(w.issues.get(work1)!.status).toBe("todo");
      expect(w2.issues.get(work2)!.status).toBe("todo");
    });

    it("a closed work issue is not cancelled again, and one the run was walked away from is cancelled by the sweep, journey or no journey", async () => {
      const w = await make();
      const id = approval(w);
      const work1 = workIssue(w, { status: "done" });
      await work(w, "esign", esignOutputs(id), { issueId: requestIssue(w) });
      expect(w.issues.get(work1)!.status).toBe("done");
      expect(w.comments.filter((c) => c.issueId === work1)).toEqual([]);

      const w2 = await make();
      const id2 = approval(w2);
      const work2 = workIssue(w2);
      const { runId } = await work(w2, "esign", esignOutputs(id2), { issueId: requestIssue(w2), stopAfter: "send-for-signature" });
      expect((await getRun(w2.ctx, A, runId))!.status).toBe("running");
      expect(w2.issues.get(work2)!.status).toBe("todo");
      w2.clock.set(new Date(Date.parse(NOW) + STALE_RUN_MS + 60_000).toISOString());
      expect(await sweepStaleRuns(w2.env, A)).toBe(1);
      expect(w2.issues.get(id2)!.status).toBe("cancelled");
      expect(w2.issues.get(work2)!.status).toBe("cancelled");

      // The journey was removed by a release while the run was open: there is no report to write, but the issue still goes.
      const w3 = await make();
      approval(w3);
      const work3 = workIssue(w3);
      const gone = await work(w3, "esign", esignOutputs("issue-sign"), { issueId: requestIssue(w3), stopAfter: "send-for-signature" });
      await w3.client.query(`UPDATE ${NAMESPACE}.acceptance_runs SET journey_key = 'removed-journey' WHERE id = $1`, [gone.runId]);
      w3.clock.set(new Date(Date.parse(NOW) + STALE_RUN_MS + 60_000).toISOString());
      expect(await sweepStaleRuns(w3.env, A)).toBe(1);
      expect(w3.issues.get(work3)!.status).toBe("cancelled");
    });

    it("site events passes when the counter moves, and says so in the report", async () => {
      const w = await make();
      const { runId, last } = await work(w, "site-events", eventsOutputs(), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("passed");
      expect((await getRun(w.ctx, A, runId))!.state.captures).toMatchObject({ keyId: "key-1", entrancesBefore: 0, pageviewsBefore: 0 });
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain("Site visit counter");
    });

    it("site events fails when the counter did not move after the post, even though the endpoint answered", async () => {
      const w = await make();
      const { runId, last } = await work(w, "site-events", eventsOutputs({ "confirm-counter-moved": { keys: 1, entrances: 0, pageviews: 0 } }), {});
      expect(last.data.status).toBe("failed");
      const step = (await getRun(w.ctx, A, runId))!.state.steps.find((st) => st.id === "confirm-counter-moved")!;
      expect(step.status).toBe("failed");
      expect(step.checks.some((c) => !c.ok && c.detail.includes("is above entrancesBefore (0)"))).toBe(true);
      // The key is still cleaned up with the canary.
      expect((await stepStatuses(w, runId)).cleanup).toBe("passed");
    });

    it("site events fails when the public endpoint refuses the event, or the plugin has no public address to give", async () => {
      const w = await make();
      const refused = await work(w, "site-events", eventsOutputs({ "send-test-event": { status: 502, body: { error: "This site key is not active." } } }), {});
      expect(refused.last.data.status).toBe("failed");
      expect((await stepStatuses(w, refused.runId))).toMatchObject({ "send-test-event": "failed", "confirm-counter-moved": "blocked", cleanup: "passed" });
      const w2 = await make();
      const noAddress = await work(w2, "site-events", eventsOutputs({ "make-key": { created: true, key: { id: "key-1", client: CANARY, canary: true, status: "active", writeKey: "pibe_example", install: { installNote: "Open the CRM page once so the plugin learns its public address." } } } }), {});
      expect(noAddress.last.data.status).toBe("failed");
      expect((await stepStatuses(w2, noAddress.runId))["make-key"]).toBe("failed");
    });

    it("a site key made for a real client aborts the run: the journey only ever works on the canary", async () => {
      const w = await make();
      expect((await acceptanceRun(w, { action: "start", journey: "site-events", client: REAL })).error).toContain("only on the canary client");
      const started = await acceptanceRun(w, { action: "start", journey: "site-events", client: CANARY });
      const runId = started.data.runId as string;
      await acceptanceRun(w, { action: "record", runId, stepId: "ensure-canary", input: {}, output: canaryClient });
      const touched = await acceptanceRun(w, { action: "record", runId, stepId: "make-key", input: { client: REAL, label: "Acceptance r1" }, output: eventsOutputs()["make-key"] });
      expect(touched.data).toMatchObject({ finished: true, status: "aborted" });
      expect((await getRun(w.ctx, A, runId))!.state.abortReason).toContain("not the canary client");
    });

    it("a release of the CRM asks for all six CRM journeys in one request, e-sign and the visit counter among them", async () => {
      const w = await make();
      const status = (version: string) => ({ companyId: A, payload: { plugin: "partnersinbiz.crm", module: "crm", title: "CRM", version, items: [], checkedAt: NOW } });
      await onSetupStatusEvent(w.env, "partnersinbiz.crm", status("0.13.0"));
      await onSetupStatusEvent(w.env, "partnersinbiz.crm", status("0.14.0"));
      const requests = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ title: "Acceptance request: 6 journeys (2026-10-04)", originId: "cockpit:acceptance:release:partnersinbiz.crm:0.14.0", assigneeAgentId: ACC });
      for (const key of ["esign", "site-events", "lead-capture", "quote-to-invoice", "email-sequence-dry-run", "client-report"]) expect(requests[0]!.description).toContain(`\`${key}\``);
      expect(requests[0]!.description).toContain("Document prepared and sent for signature");
      expect(requests[0]!.description).toContain("Site visit counter");
      // The nightly request is still the lead form alone.
      expect(JOURNEYS.filter((j) => j.schedule.includes("nightly")).map((j) => j.key)).toEqual(["lead-capture"]);
    });
  });

  describe("a run an agent walked away from", () => {
    const sequenceOutputs = (approvalId: string): Record<string, unknown> => ({
      "ensure-canary": { client: CANARY, contact: { ref: "contact:canary-contact-1a2b3c4d", email: "canary@canary.invalid" } },
      "create-email-sequence": { id: "seq-1", name: "Canary acceptance", delivery: "email", emailApproved: false, approvalIssueId: approvalId },
      "enroll-canary-contact": { id: "enr-1", status: "running" },
      cleanup: { cleaned: true, company: CANARY },
    });
    const approval = (w: Hybrid, over: Record<string, unknown> = {}) => {
      w.issues.set("issue-appr", { id: "issue-appr", companyId: A, title: "Approve email sending: Canary acceptance", description: `Sequence for ${CANARY} (PiB Canary Co)`, status: "todo", assigneeAgentId: REV, identifier: "PAR-960", originKind: "plugin:partnersinbiz.crm", ...over });
      return "issue-appr";
    };
    const LATER = new Date(Date.parse(NOW) + STALE_RUN_MS + 60_000).toISOString();
    /** A run whose agent died right after the approval step passed. */
    async function abandoned(w: Hybrid, over: Record<string, unknown> = {}) {
      const id = approval(w, over);
      const { runId } = await work(w, "email-sequence-dry-run", sequenceOutputs(id), { issueId: requestIssue(w), stopAfter: "create-email-sequence" });
      expect((await getRun(w.ctx, A, runId))!.status).toBe("running");
      expect(w.issues.get(id)!.status).toBe("todo");
      return { id, runId };
    }

    it("the next start of the journey aborts it and cancels the canary's approval it left in the owner's queue", async () => {
      const w = await make();
      const { id, runId } = await abandoned(w);
      w.clock.set(LATER);
      expect((await acceptanceRun(w, { action: "start", journey: "email-sequence-dry-run", client: CANARY })).error).toBeUndefined();
      expect((await getRun(w.ctx, A, runId))!.status).toBe("aborted");
      expect(w.issues.get(id)!.status).toBe("cancelled");
      expect(w.comments.find((c) => c.issueId === id)!.body).toContain(`Cancelled by acceptance run ${runId}`);
      // The request the run answered says it was aborted, not passed.
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain("ABORTED");
    });

    it("the nightly sweep ends it without waiting for a journey to start again, and leaves a run that is still young alone", async () => {
      const w = await make();
      const { id, runId } = await abandoned(w);
      w.clock.set(LATER);
      const totals = await nightlyAcceptance(w.env);
      expect(totals.swept).toBe(1);
      expect((await getRun(w.ctx, A, runId))!.status).toBe("aborted");
      expect(w.issues.get(id)!.status).toBe("cancelled");
      // A run started after the sweep is young: the next sweep leaves it alone (one open run per company, so it cannot start while the stale one was still open).
      const young = await acceptanceRun(w, { action: "start", journey: "seo-sprint-draft", client: CANARY });
      expect(young.error).toBeUndefined();
      expect(await sweepStaleRuns(w.env, A)).toBe(0);
      expect((await getRun(w.ctx, A, young.data.runId))!.status).toBe("running");
    });

    it("an approval that does not name the canary is left open and the report says so, even for a swept run", async () => {
      const w = await make();
      const { id } = await abandoned(w, { title: "Approve email sending: Q4 reactivation", description: "A real client's sequence" });
      w.clock.set(LATER);
      await sweepStaleRuns(w.env, A);
      expect(w.issues.get(id)!.status).toBe("todo");
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain(`Left open, because it does not name the canary: ${id}`);
    });

    it("a run whose journey is gone still has its approvals cancelled", async () => {
      const w = await make();
      const { id, runId } = await abandoned(w);
      await w.client.query(`UPDATE ${NAMESPACE}.acceptance_runs SET journey_key = 'removed-journey' WHERE id = $1`, [runId]);
      w.clock.set(LATER);
      expect(await sweepStaleRuns(w.env, A)).toBe(1);
      expect((await getRun(w.ctx, A, runId))!.status).toBe("aborted");
      expect(w.issues.get(id)!.status).toBe("cancelled");
    });

    it("is scoped to the company: another company's stale run is not touched", async () => {
      const w = await make();
      const { runId } = await abandoned(w);
      w.clock.set(LATER);
      expect(await sweepStaleRuns(w.env, "cccccccc-0000-4000-8000-0000000000c1")).toBe(0);
      expect((await getRun(w.ctx, A, runId))!.status).toBe("running");
    });

    it("the nightly sweep also cancels the other open issues about the canary made since the run started, and not older ones (0.6.5)", async () => {
      const w = await make();
      const { runId } = await abandoned(w);
      const [since, older] = await strayIssues(w, [["SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co", { createdAt: at(5) }], ["SEO W0 · Set up Bing Webmaster Tools — PiB Canary Co", { createdAt: at(-30) }]]);
      w.clock.set(LATER);
      expect((await nightlyAcceptance(w.env)).swept).toBe(1);
      expect((await getRun(w.ctx, A, runId))!.status).toBe("aborted");
      expect(w.issues.get(since!)!.status).toBe("cancelled");
      expect(w.comments.find((c) => c.issueId === since)!.body).toContain(`Cancelled by acceptance run ${runId}: this was a rehearsal on the fake canary client`);
      expect(w.issues.get(older!)!.status).toBe("todo");
      expect(w.comments.find((c) => c.issueId === "issue-req")!.body).toContain("1 other open issue about the canary was cancelled (1)");
    });

    it("a run whose journey is gone, or changed while it was open, still has the issues it left about the canary cancelled (0.6.5)", async () => {
      const w = await make();
      const { id, runId } = await abandoned(w);
      const since = await strayIssue(w, "SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co");
      await w.client.query(`UPDATE ${NAMESPACE}.acceptance_runs SET journey_key = 'removed-journey' WHERE id = $1`, [runId]);
      w.clock.set(LATER);
      expect(await sweepStaleRuns(w.env, A)).toBe(1);
      expect(w.issues.get(id)!.status).toBe("cancelled");
      expect(w.issues.get(since)!.status).toBe("cancelled");

      // The journey changed (a release) under an open run: it ends without a report, and its approval and strays go the same way.
      const w2 = await make();
      const open = await abandoned(w2);
      const since2 = await strayIssue(w2, "Deal won: Canary rehearsal r2 for PiB Canary Co");
      await w2.client.query(`UPDATE ${NAMESPACE}.acceptance_runs SET journey_version = 99 WHERE id = $1`, [open.runId]);
      w2.clock.set(at(10));
      expect((await acceptanceRun(w2, { action: "record", runId: open.runId, stepId: "enroll-canary-contact", input: {}, output: {} })).error).toContain("The journey changed");
      expect((await getRun(w2.ctx, A, open.runId))!.status).toBe("aborted");
      expect(w2.issues.get(open.id)!.status).toBe("cancelled");
      expect(w2.issues.get(since2)!.status).toBe("cancelled");
    });
  });

  describe("the net under a rehearsal: open issues about the canary (0.6.5)", () => {
    /** Works the lead capture to its end. It starts at NOW and ends ten minutes later. */
    const rehearse = async (w: Hybrid, options: { issueId?: string; lead?: Record<string, unknown> } = {}) => {
      const lead = leadIssue(w);
      return work(w, "lead-capture", { ...good(lead), ...(options.lead ?? {}) }, { issueId: options.issueId ?? requestIssue(w), afterStart: () => w.clock.set(at(10)) });
    };
    const reportOf = (w: Hybrid, id = "issue-req") => w.comments.find((c) => c.issueId === id)!.body;
    /** Watches the read the net makes of the issues table (the database answers it for real); `answer` may replace what it gets back. */
    const watchIssueReads = (w: Hybrid, answer: (sql: string, params: unknown[], run: () => Promise<unknown[]>) => Promise<unknown[]>) => {
      const db = w.ctx.db;
      (w.ctx as unknown as { db: unknown }).db = { ...db, query: (sql: string, params: unknown[] = []) => (/FROM public\.issues/.test(sql) && /ILIKE/.test(sql) ? answer(sql, params, () => db.query(sql, params)) : db.query(sql, params)) };
    };
    /** The issue that must go, and everything the net must leave alone (the request is one: it names the canary and is still open when the run ends). */
    const bystanders = async (w: Hybrid) => {
      const request = await strayIssue(w, "Run the PiB Canary Co journeys now", { createdAt: at(1), assigneeUserId: null, assigneeAgentId: ACC });
      const mine = await strayIssue(w, "SEO W0 · Set up Bing Webmaster Tools — PiB Canary Co");
      const untouched = await strayIssues(w, [
        // A real client's issue: the canary is named only in its text, and the title rules.
        ["Fix the checkout for Acme Plumbing", { description: "Seen while the PiB Canary Co journeys ran (company:canary-1a2b3c4d)." }],
        ["Acme Plumbing: Canary Coffee menu page"],
        ["SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co", { createdAt: at(-1) }],
        ["Deal won: Canary rehearsal run3 for PiB Canary Co", { createdAt: at(30) }],
        ["Acceptance failure: Quote to invoice, Open a deal for PiB Canary Co", { originKind: ORIGIN.acceptance }],
        ["Acceptance failure: Quote to invoice, Open a deal for PiB Canary Co", { originKind: "manual" }],
        ["Acceptance request: PiB Canary Co journeys (2026-10-03)", { originKind: "manual" }],
        ["Canary rehearsal run0: follow-up", { originKind: ORIGIN.acceptance }],
        ["Deal won: Canary rehearsal run1 for PiB Canary Co", { status: "done" }],
        ["Approve sending invoice to PiB Canary Co (R 1,000.00)", { status: "cancelled" }],
        ["SEO W0 · Link to the site from another site we own — PiB Canary Co", { status: "backlog" }],
        ["SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co", { companyId: "cccccccc-0000-4000-8000-0000000000c1" }],
      ]);
      return { request, mine, untouched };
    };
    const expectBystandersLeftAlone = (w: Hybrid, seen: { request: string; mine: string; untouched: string[] }, before: Record<string, string>) => {
      // Proof the net ran, so "left alone" is not just "never looked".
      expect(w.issues.get(seen.mine)!.status).toBe("cancelled");
      expect(w.issues.get(seen.request)!.status).toBe("todo");
      for (const id of seen.untouched) {
        expect(w.issues.get(id)!.status, `${w.issues.get(id)!.title} (${id})`).toBe(before[id]);
        expect(w.comments.filter((c) => c.issueId === id), id).toEqual([]);
      }
      expect(w.comments.filter((c) => c.issueId === seen.request).every((c) => !c.body.startsWith("Cancelled by"))).toBe(true);
      expect(reportOf(w, seen.request)).toContain("1 other open issue about the canary was cancelled (1)");
      // Nothing was tried and refused either: what is not the rehearsal's is dropped, not left for a person.
      expect(reportOf(w, seen.request)).not.toContain("not cancelled");
    };

    it("cancels what a rehearsal left open about the canary, whoever it is for and whatever state it is open in, and the report says how many", async () => {
      const w = await make();
      const gone = await strayIssues(w, [
        ["Deal won: Canary rehearsal run92ba542ec733 for PiB Canary Co, R 1,000.00: convert quote Q-PIB-002", { assigneeAgentId: AM, assigneeUserId: null, originKind: "plugin:partnersinbiz.billing" }],
        ["SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co", { status: "in_progress", assigneeAgentId: AM, assigneeUserId: null }],
        ["Approve sending invoice to PiB Canary Co (R 1,000.00)", { status: "in_review", assigneeAgentId: REV, assigneeUserId: null, originKind: "plugin:partnersinbiz.billing" }],
        ["Approve email sending: Canary acceptance run911e46ce64be", { status: "blocked", originKind: "plugin:partnersinbiz.crm" }],
        ["[PiB Canary Co] Review social post: Acceptance run run1c98e20d9ddb: a rehearsal draft", { originKind: "plugin:partnersinbiz.social" }],
      ]);
      const { runId, last } = await rehearse(w);
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      for (const id of gone) {
        expect(w.issues.get(id)!.status, id).toBe("cancelled");
        expect(w.comments.filter((c) => c.issueId === id).map((c) => c.body)).toEqual([`Cancelled by acceptance run ${runId}: this was a rehearsal on the fake canary client (PiB Canary Co), so no real client or person is waiting on it.`]);
      }
      const line = "5 other open issues about the canary were cancelled (5): a rehearsal on the fake canary client, so nobody real was waiting on them.";
      expect(reportOf(w)).toContain(line);
      expect((await getRun(w.ctx, A, runId))!.report).toContain(line);
    });

    it("any one of the four names is enough, in any case, in the title", async () => {
      const w = await make();
      const named = await strayIssues(w, ["Hand-off for PiB Canary Co", "Approve email sending: Canary acceptance run911e", "Proposal: Acceptance rehearsal run1", "Deal won: Canary rehearsal run2", "new lead: pib canary co"].map((title): [string] => [title]));
      await rehearse(w);
      for (const id of named) expect(w.issues.get(id)!.status, w.issues.get(id)!.title).toBe("cancelled");
      expect(reportOf(w)).toContain("5 other open issues about the canary were cancelled (5)");
    });

    it("says one in the singular", async () => {
      const w = await make();
      await strayIssue(w, "SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co");
      await rehearse(w);
      expect(reportOf(w)).toContain("1 other open issue about the canary was cancelled (1): a rehearsal on the fake canary client, so nobody real was waiting on it.");
    });

    it("leaves alone a real client's issue, one made before the run or after it ended, the run's own request and failures, and a closed one", async () => {
      const w = await make();
      const seen = await bystanders(w);
      const before = Object.fromEntries(seen.untouched.map((id) => [id, w.issues.get(id)!.status]));
      const { last } = await rehearse(w, { issueId: seen.request });
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      expectBystandersLeftAlone(w, seen, before);
    });

    it("checks every row the read gives back, so a read that returned too much would still cancel only the rehearsal's own", async () => {
      const w = await make();
      const seen = await bystanders(w);
      const before = Object.fromEntries(seen.untouched.map((id) => [id, w.issues.get(id)!.status]));
      // Every issue of every company, closed or not, made when it was made.
      watchIssueReads(w, async () => (await w.client.query("SELECT id::text AS id, company_id::text AS company_id, identifier, title, status, origin_kind, created_at FROM public.issues")).rows);
      const { last } = await rehearse(w, { issueId: seen.request });
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      expectBystandersLeftAlone(w, seen, before);
    });

    it("never cancels more than 60, looks at no more than the newest 200, and the report names what it left", async () => {
      const w = await make();
      const reads: string[] = [];
      watchIssueReads(w, async (sql, _params, run) => {
        reads.push(sql);
        return run();
      });
      // Oldest first: 230 open issues, one every two seconds from a minute into the run.
      const ids = await strayIssues(w, Array.from({ length: 230 }, (_, i): [string, Record<string, unknown>] => [`SEO W0 · task ${i} — PiB Canary Co`, { status: i % 2 ? "in_progress" : "todo", createdAt: new Date(Date.parse(at(1)) + i * 2000).toISOString() }]));
      await rehearse(w);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain("LIMIT 200");
      // The newest 200 are looked at (30 to 229), the first 60 of them cancelled (the newest, 170 to 229), and the 140 below are named.
      const cancelled = ids.filter((id) => w.issues.get(id)!.status === "cancelled");
      expect(cancelled).toEqual(ids.slice(170));
      expect(ids.slice(0, 170).map((id) => w.issues.get(id)!.status)).toEqual(ids.slice(0, 170).map((_, i) => (i % 2 ? "in_progress" : "todo")));
      const report = reportOf(w);
      expect(report).toContain("60 other open issues about the canary were cancelled (60)");
      expect(report).toContain(`Named the canary but not cancelled (past the limit of 60 a run cancels, or the host refused): ${ids.slice(160, 170).reverse().join(", ")} and 130 more. A person looks at them.`);
    });

    it("never stops a run: a host that will not cancel one issue, or will not answer the read, is not a failure of the run", async () => {
      const w = await make();
      const [stuck, fine] = await strayIssues(w, [["SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co"], ["SEO W0 · Set up Bing Webmaster Tools — PiB Canary Co"]]);
      const issues = w.ctx.issues as unknown as { update: (id: string, patch: Record<string, unknown>, companyId: string) => Promise<unknown> };
      const update = issues.update.bind(issues);
      issues.update = async (id, patch, companyId) => {
        if (id === stuck) throw new Error("the host says no");
        return update(id, patch, companyId);
      };
      const { runId, last } = await rehearse(w);
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      expect((await getRun(w.ctx, A, runId))!.status).toBe("passed");
      expect(w.issues.get(stuck!)!.status).toBe("todo");
      expect(w.issues.get(fine!)!.status).toBe("cancelled");
      expect(reportOf(w)).toContain("1 other open issue about the canary was cancelled (1)");
      expect(reportOf(w)).toContain(`Named the canary but not cancelled (past the limit of 60 a run cancels, or the host refused): ${stuck}. A person looks at it.`);

      const w2 = await make();
      const kept = await strayIssue(w2, "SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co");
      watchIssueReads(w2, async () => {
        throw new Error("the host is down");
      });
      const second = await rehearse(w2);
      expect(second.last.data).toMatchObject({ finished: true, status: "passed" });
      expect(w2.issues.get(kept)!.status).toBe("todo");
      expect(reportOf(w2)).not.toContain("other open issue");
    });

    it("filing a finished run's report again never reaches into issues made after the run ended, or into the report issue itself", async () => {
      const w = await make();
      const during = await strayIssue(w, "SEO W0 · Claim and verify the Google Business Profile — PiB Canary Co");
      const { runId } = await rehearse(w, { lead: { "mark-prospect": { lifecycle: "lead" } } });
      expect(w.issues.get(during)!.status).toBe("cancelled");
      // A later run's issue, open while the report of this one is filed again an hour on; and a report issue (made during the run) that names the canary.
      const later = await strayIssue(w, "Deal won: Canary rehearsal run7 for PiB Canary Co", { createdAt: at(30) });
      const report = await strayIssue(w, "Acceptance run summary for PiB Canary Co", { createdAt: at(6) });
      w.clock.set(at(60));
      await w.client.query(`UPDATE ${NAMESPACE}.acceptance_runs SET child_issue_ids = '{}'::jsonb, report_issue_id = $2 WHERE id = $1`, [runId, report]);
      expect((await call(w, "acceptance-report", { runId, file: true })).data.refiled).toBe(true);
      expect(w.issues.get(later)!.status).toBe("todo");
      expect(w.issues.get(report)!.status).toBe("todo");
      expect(w.comments.some((c) => c.issueId === report && c.body.includes("## Acceptance:"))).toBe(true);
    });
  });

  describe("the SEO sprint journey (0.6.5)", () => {
    const SPRINT = "29ba7904-ea9d-47bd-9ed7-380272b46b64";
    const outputs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      "ensure-canary": { client: CANARY, contact: { ref: "contact:canary-contact-1a2b3c4d", email: "canary@canary.invalid" } },
      // What partnersinbiz.seo:create-sprint answers (the live answer of 2026-10-04, trimmed): the sprint is `sprintId`, and `issuesOpened` counts the task issues it opened.
      "create-sprint": { sprintId: SPRINT, siteUrl: "https://canary.invalid", siteName: "PiB Canary Co", client: CANARY, startDate: "2027-11-08", status: "pre_launch", day: -400, autopilotMode: "off", rootIssueId: "root-1", seededTasks: 46, issuesOpened: 0, issuesPending: 0, warnings: [] },
      "add-keyword": { added: 1 },
      "read-tasks": { count: 46, tasks: [] },
      "archive-sprint": { sprintId: SPRINT, status: "archived" },
      cleanup: { cleaned: true, company: CANARY },
      ...over,
    });

    it("passes on the answer the SEO plugin gives, and every later step works on the sprint it named", async () => {
      const w = await make();
      const { runId, last } = await work(w, "seo-sprint-draft", outputs(), { issueId: requestIssue(w) });
      expect(last.data).toMatchObject({ finished: true, status: "passed" });
      const row = (await getRun(w.ctx, A, runId))!;
      expect(row).toMatchObject({ journeyVersion: 3, summary: "Passed: 6 of 6 steps." });
      expect(row.state.captures.sprintId).toBe(SPRINT);
      for (const id of ["add-keyword", "read-tasks", "archive-sprint"]) expect(row.state.steps.find((st) => st.id === id)!.input, id).toMatchObject({ sprintId: SPRINT });
    });

    it("fails when the sprint opened work: a rehearsal must never create any, and the step says how many it opened", async () => {
      const w = await make();
      const answer = { ...(outputs()["create-sprint"] as object), issuesOpened: 9 };
      const { runId, last } = await work(w, "seo-sprint-draft", outputs({ "create-sprint": answer }), { issueId: requestIssue(w) });
      expect(last.data.status).toBe("failed");
      const row = (await getRun(w.ctx, A, runId))!;
      const step = row.state.steps.find((st) => st.id === "create-sprint")!;
      expect(step.status).toBe("failed");
      expect(step.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual(["issuesOpened is 0; got 9"]);
      expect(row.state.steps.map((st) => st.status)).toEqual(["passed", "failed", "blocked", "blocked", "passed", "passed"]);
      expect(row.state.captures.sprintId).toBeUndefined();

      // The sprint exists all the same, so the archive step is still handed out; the Cockpit has no id to fill in, and the step's note says where to take it from.
      const w2 = await make();
      const open = await work(w2, "seo-sprint-draft", outputs({ "create-sprint": answer }), { issueId: requestIssue(w2), stopAfter: "create-sprint" });
      const next = await acceptanceRun(w2, { action: "next", runId: open.runId });
      expect(next.data.step).toMatchObject({ id: "archive-sprint", unfilled: ["sprintId"] });
      expect(next.data.step.note).toContain("sprintId from the answer of create-sprint");
    });

    it("fails, naming the field, on an answer that calls the sprint id (the first live run's mistake)", async () => {
      const w = await make();
      const { runId } = await work(w, "seo-sprint-draft", outputs({ "create-sprint": { id: SPRINT, issuesOpened: 0 } }), {});
      const step = (await getRun(w.ctx, A, runId))!.state.steps.find((st) => st.id === "create-sprint")!;
      expect(step.checks.filter((c) => !c.ok).map((c) => c.detail)).toEqual(["sprintId is missing from the result"]);
    });
  });

  describe("the three ways a request opens", () => {
    it("every night, one request for the Acceptance agent, once a day, and none for a company with no agent", async () => {
      const w = await make();
      await w.jobs.get(JOBS.acceptanceNightly)!();
      await w.jobs.get(JOBS.acceptanceNightly)!();
      const requests = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ title: "Acceptance request: Lead captured and qualified (2026-10-04)", assigneeAgentId: ACC, originId: "cockpit:acceptance:nightly:2026-10-04" });
      expect(requests[0]!.description).toContain("create-canary-client");
      expect(requests[0]!.description).toContain("Never approve, send or publish");
      expect(w.wakeups).toContain(requests[0]!.id);
      w.clock.set("2026-10-05T02:40:00.000Z");
      await w.jobs.get(JOBS.acceptanceNightly)!();
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toHaveLength(2);
      const bare = await make({ acceptance: false });
      await bare.jobs.get(JOBS.acceptanceNightly)!();
      expect([...bare.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toEqual([]);
    });

    it("a plugin that reports a new version is a release: the journeys that exercise it get a request", async () => {
      const w = await make();
      const status = (version: string | null) => ({ companyId: A, payload: { plugin: "partnersinbiz.billing", module: "billing", title: "Billing", version, items: [], checkedAt: NOW } });
      // The first sighting only records the version.
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.5.3"));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toEqual([]);
      // The same version again: nothing.
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.5.3"));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toEqual([]);
      // A new one: a request for the journeys that exercise Billing.
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.6.0"));
      const requests = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ title: "Acceptance request: Deal, quote, accepted, invoice ready to send (2026-10-04)", priority: "high", originId: "cockpit:acceptance:release:partnersinbiz.billing:0.6.0", assigneeAgentId: ACC });
      expect(requests[0]!.description).toContain("billing was released (0.5.3 to 0.6.0)");
      // Redelivered with the same version: still one request.
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.6.0"));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toHaveLength(1);
      // A rollback is a release of other code: it is checked once; coming forward again to a version that was already checked opens nothing new.
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.5.3"));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toHaveLength(2);
      await onSetupStatusEvent(w.env, "partnersinbiz.billing", status("0.6.0"));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toHaveLength(2);
    });

    it("through the real subscription: the setup status a plugin emits is what the Cockpit reads the version from", async () => {
      const w = await make();
      const emit = (version: string) => w.fire(pluginEvent("partnersinbiz.billing", SETUP_EVENTS.status), { companyId: A, payload: { plugin: "partnersinbiz.billing", module: "billing", title: "Billing", version, items: [], checkedAt: NOW } });
      await emit("0.5.3");
      await emit("0.6.1");
      const requests = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance);
      expect(requests.map((r) => r.originId)).toEqual(["cockpit:acceptance:release:partnersinbiz.billing:0.6.1"]);
      // The setup snapshot is still kept for Waiting on you: the release check never replaces it.
      const kept = await w.client.query(`SELECT payload FROM ${(await import("../src/namespace.js")).NAMESPACE}.snapshots WHERE company_id = $1 AND plugin_key = 'partnersinbiz.billing' AND kind = 'setup'`, [A]);
      expect(kept.rows).toHaveLength(1);
    });

    it("a plugin with no journey of its own, or no version, starts nothing", async () => {
      const w = await make();
      const status = (plugin: string, version: string | null) => ({ companyId: A, payload: { plugin, module: null, title: plugin, version, items: [], checkedAt: NOW } });
      await onSetupStatusEvent(w.env, "partnersinbiz.payroll", status("partnersinbiz.payroll", "0.3.0"));
      await onSetupStatusEvent(w.env, "partnersinbiz.payroll", status("partnersinbiz.payroll", "0.4.0"));
      await onSetupStatusEvent(w.env, "partnersinbiz.seo", status("partnersinbiz.seo", null));
      await onSetupStatusEvent(w.env, "partnersinbiz.seo", status("partnersinbiz.seo", ""));
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.acceptance)).toEqual([]);
    });

    it("a release with no Acceptance agent staffed claims nothing (the next one can open it)", async () => {
      const w = await make({ acceptance: false });
      const result = await openAcceptanceRequest(w.env, A, { key: "release:partnersinbiz.crm:0.13.0", trigger: "release", journeys: [journeyByKey("lead-capture")!], why: "x" });
      expect(result.action).toBe("no-agent");
      await w.actions.get("cockpit.link-agent")!({ role: "acceptance", agentId: ACC }, userCtx);
      expect((await openAcceptanceRequest(w.env, A, { key: "release:partnersinbiz.crm:0.13.0", trigger: "release", journeys: [journeyByKey("lead-capture")!], why: "x" })).action).toBe("opened");
    });

    it("a person asks for one now: all journeys, or the named ones, and a bad name is refused", async () => {
      const w = await make();
      const result = (await w.actions.get("acceptance.request")!({ journeys: ["seo-sprint-draft"] }, userCtx)) as { action: string; issueId: string };
      expect(result.action).toBe("opened");
      expect(w.issues.get(result.issueId)!.title).toBe("Acceptance request: SEO sprint on a fixture site, not started (2026-10-04)");
      await expect(w.actions.get("acceptance.request")!({ journeys: ["ghost"] }, userCtx)).rejects.toThrow(/No journey matches/);
      await expect(w.actions.get("acceptance.request")!({}, { companyId: A, actor: { type: "agent", agentId: ACC } })).rejects.toThrow(/board user/);
    });
  });

  describe("the Acceptance agent as a role", () => {
    it("is linked by hand, wired with its skill and tool access, and reported in the Cockpit's team", async () => {
      const w = await make({ acceptance: false });
      expect(await acceptanceAgentId(w.env, A)).toBeNull();
      const linked = (await w.actions.get("cockpit.link-agent")!({ role: "acceptance", agentId: ACC }, userCtx)) as { agent: { id: string }; steps: string[] };
      expect(linked.agent.id).toBe(ACC);
      expect(linked.steps.join("\n")).toContain("Synced the `pib-acceptance` skill.");
      expect(linked.steps.join("\n")).toContain("plugin tool access");
      expect(w.grants.get(ACC)).toBeDefined();
      expect(await acceptanceAgentId(w.env, A)).toBe(ACC);
      const snapshot = (await (await import("../src/own.js")).ownSnapshot(w.env, A)).team!;
      expect(snapshot.find((m) => (m.role as string) === "acceptance")).toMatchObject({ agentId: ACC });
      const setup = await (await import("../src/own.js")).ownSetupStatus(w.env, A);
      expect(setup.items.find((i) => i.key === "acceptance_agent")).toMatchObject({ status: "done", required: false });
      await w.actions.get("cockpit.unlink-agent")!({ role: "acceptance" }, userCtx);
      expect(await acceptanceAgentId(w.env, A)).toBeNull();
    });

    it("has a hire task like the Operator's, with the run profile", async () => {
      const w = await make({ acceptance: false });
      const options = (await w.actions.get("cockpit.hire-options")!({ role: "acceptance" }, userCtx)) as { draft: { title: string; description: string } };
      expect(options.draft.title).toBe("Hire: Acceptance (Cockpit agent)");
      expect(options.draft.description).toContain("`pib-acceptance`");
      expect(options.draft.description).toContain("claude-sonnet-5-5");
      expect(options.draft.description).toContain("| **Concurrent runs** | 1 |");
      const hired = (await w.actions.get("cockpit.start-hire")!({ role: "acceptance", assigneeAgentId: OP }, userCtx)) as { hire: { issueId: string } };
      expect(w.issues.get(hired.hire.issueId)!.originId).toBe("hire:acceptance");
      // The Operator and the Reviewer are still saved with the team, never linked here.
      await expect(w.actions.get("cockpit.link-agent")!({ role: "operator", agentId: OP }, userCtx)).rejects.toThrow(/cockpit\.save-team/);
      await expect(w.actions.get("cockpit.hire-options")!({ role: "ghost" }, userCtx)).rejects.toThrow(/operator or reviewer/);
    });
  });

  describe("what the health checks say", () => {
    it("says nothing without an Acceptance agent, and a passing set is a green count", async () => {
      const w = await make({ acceptance: false });
      expect(await acceptanceChecks(w.env, A)).toEqual({ health: [], kpis: [] });
      const w2 = await make();
      const lead = leadIssue(w2);
      await work(w2, "lead-capture", good(lead), { issueId: requestIssue(w2) });
      const checks = await acceptanceChecks(w2.env, A);
      expect(checks.health).toEqual([]);
      expect(checks.kpis[0]).toMatchObject({ key: "acceptance_passing", value: "1 of 1", tone: "ok" });
    });

    it("a failing journey is a warning for a day, then red, and clears when it passes", async () => {
      const w = await make();
      const lead = leadIssue(w);
      await work(w, "lead-capture", { ...good(lead), "mark-prospect": { lifecycle: "lead" } }, { issueId: requestIssue(w) });
      const warn = (await acceptanceChecks(w.env, A)).health[0]!;
      expect(warn).toMatchObject({ key: "acceptance:failing", status: "warn", title: "1 acceptance journey is failing" });
      expect(warn.detail).toContain("Lead captured and qualified: Failed at Set the contact to prospect.");
      w.clock.set(new Date(Date.parse(NOW) + 25 * 3_600_000).toISOString());
      expect((await acceptanceChecks(w.env, A)).health[0]).toMatchObject({ status: "bad" });
      // The next run passes: the check clears.
      leadIssue(w);
      await work(w, "lead-capture", good("issue-lead"), { issueId: requestIssue(w, "issue-req2") });
      expect((await acceptanceChecks(w.env, A)).health).toEqual([]);
      expect((await latestRuns(w.ctx, A)).map((r) => r.status)).toEqual(["passed"]);
    });

    it("warns when the nightly request is not being worked", async () => {
      const w = await make();
      await w.jobs.get(JOBS.acceptanceNightly)!();
      expect((await acceptanceChecks(w.env, A)).health).toEqual([]);
      w.clock.set(new Date(Date.parse(NOW) + 49 * 3_600_000).toISOString());
      expect((await acceptanceChecks(w.env, A)).health[0]).toMatchObject({ key: "acceptance:stale", status: "warn", href: "/setup?section=team" });
    });

    it("the Cockpit's own snapshot carries the acceptance checks and the nightly job's health", async () => {
      const w = await make();
      const lead = leadIssue(w);
      await work(w, "lead-capture", { ...good(lead), "mark-prospect": { lifecycle: "lead" } }, { issueId: requestIssue(w) });
      const snapshot = await (await import("../src/own.js")).ownSnapshot(w.env, A);
      expect(snapshot.health.some((h) => h.key === "acceptance:failing")).toBe(true);
      expect(snapshot.health.some((h) => h.title === "Nightly acceptance request")).toBe(true);
      expect(snapshot.kpis.some((k) => k.key === "acceptance_passing")).toBe(true);
    });
  });

  describe("the report tool", () => {
    it("reads a run, a journey's latest run, and every journey's latest", async () => {
      const w = await make();
      const lead = leadIssue(w);
      const { runId } = await work(w, "lead-capture", good(lead), { issueId: requestIssue(w) });
      const byRun = await call(w, "acceptance-report", { runId });
      expect(byRun.data).toMatchObject({ runId, status: "passed", journey: "lead-capture" });
      expect(byRun.data.report).toContain("PASSED");
      const byJourney = await call(w, "acceptance-report", { journey: "lead-capture" });
      expect(byJourney.data.runId).toBe(runId);
      const all = await call(w, "acceptance-report", {});
      expect(all.content).toBe("1 of 1 journeys pass on their latest run.");
      expect((await call(w, "acceptance-report", { runId: "run-nope" })).error).toContain("No run run-nope");
      expect((await call(w, "acceptance-report", { journey: "seo-sprint-draft" })).error).toContain("No run of seo-sprint-draft yet");
      const running = await acceptanceRun(w, { action: "start", journey: "seo-sprint-draft", client: CANARY });
      expect((await call(w, "acceptance-report", { runId: running.data.runId })).data.report).toContain("has not finished");
    });

    it("files a finished run's missing report and failure issues again, once", async () => {
      const w = await make();
      const lead = leadIssue(w);
      const { runId } = await work(w, "lead-capture", { ...good(lead), "mark-prospect": { lifecycle: "lead" } });
      // The filing was lost: forget the children and the report issue.
      await w.client.query(`UPDATE ${(await import("../src/namespace.js")).NAMESPACE}.acceptance_runs SET child_issue_ids = '{}'::jsonb, report_issue_id = NULL WHERE id = $1`, [runId]);
      const refiled = await call(w, "acceptance-report", { runId, file: true });
      expect(refiled.data.refiled).toBe(true);
      expect(refiled.data.failureIssues["mark-prospect"]).toBeDefined();
      const again = await call(w, "acceptance-report", { runId, file: true });
      expect(again.data.refiled).toBe(false);
    });
  });

  it("subscribes to each host event once: the setup-status handler that sees releases is the same one that records versions", async () => {
    const w = await make();
    const duplicated = [...w.handlers.entries()].filter(([, list]) => list.length > 1).map(([name]) => name);
    expect(duplicated).toEqual([]);
  });

  it("every journey can be started, and a journey that changed under an open run aborts it", async () => {
    const w = await make();
    // One open run per company: each journey starts once the previous one is over.
    for (const j of JOURNEYS) {
      const started = await acceptanceRun(w, { action: "start", journey: j.key, client: CANARY });
      expect(started.error, j.key).toBeUndefined();
      await acceptanceRun(w, { action: "abort", runId: started.data.runId, reason: "test" });
    }
    expect((await acceptanceRun(w, { action: "start", journey: "lead-capture", client: CANARY })).error).toBeUndefined();
    const run1 = (await listRuns(w.ctx, A, { journey: "lead-capture", status: "running" }))[0]!;
    await w.client.query(`UPDATE ${(await import("../src/namespace.js")).NAMESPACE}.acceptance_runs SET journey_version = 99 WHERE id = $1`, [run1.id]);
    const recorded = await acceptanceRun(w, { action: "record", runId: run1.id, stepId: "ensure-canary", input: {}, output: {} });
    expect(recorded.error).toContain("The journey changed");
    expect((await getRun(w.ctx, A, run1.id))!.status).toBe("aborted");
  });
});
