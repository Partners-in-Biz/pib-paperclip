// Task-list time for an owner, before and after stage C (PAR-12608 AC-L12; PAR-12747,
// C-sweep-3). The task list for an owner on a company of PAR's size may be at most
// 10 percent slower than before stage C.
//
// Method:
// 1. Two real servers in `authenticated` mode, each with its own throwaway home and
//    embedded PostgreSQL: one from the last commit before stage C, one from the commit
//    under test. The kill switch `PAPERCLIP_MEMBER_RESTRICTION` is unset on both.
// 2. `seed-task-list-company.ts` seeds the same PAR-size company into both databases,
//    with an owner board key (`MEASURE_OWNER_TOKEN`).
// 3. This script calls the owner's task list on both servers over HTTP, in rounds. In
//    each round every request kind goes to both servers, the order flipping every round,
//    so load on the shared host falls on both sides alike. The first `--warmup` rounds
//    are not counted. Each sample is the time to the whole response body.
//    The compact list keeps a response for 2 seconds per company, query and actor
//    (`ISSUE_LIST_SERVER_CACHE_TTL_MS` in `routes/issues.ts`, the same before and after).
//    A sample must measure the list being built, so the same request goes to the same
//    server only `--min-gap-ms` (default 2500) after its last response ended (the entry
//    expires 2 seconds after the response is built), and every counted response
//    must say `X-Paperclip-Request-Cache: miss` (or carry no such header, as `index` does).
// 4. Both servers must answer 200 with the same rows in the same order (the body hash
//    is reported too). The result is the ratio of medians, after over before, per kind.
//    `--assert` exits 1 when any ratio is above 1 + `--max-slowdown` (default 0.10).
// 5. Run it once per mode of the seeded company on the after server
//    (`seed-task-list-company.ts --set-mode=off|report|enforce`); `off` is how stage C ships.
//
//   MEASURE_OWNER_TOKEN=... node server/node_modules/tsx/dist/cli.mjs \
//     server/scripts/measure-task-list-time.ts --before=http://127.0.0.1:3242 \
//     --after=http://127.0.0.1:3241 --label=off --runs=100 --warmup=10 --assert
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const SEEDED_COMPANY_ID = "56468fd1-0ae7-5dc3-84de-c20fdc86f896"; // seededId("company", 1) in seed-task-list-company.ts

// The requests the task list sends for an owner: the Issues page first page (compact and
// streamlined `index` projections, `ui/src/pages/Issues.tsx`) and one page of `listAll`.
export const TASK_LIST_REQUESTS = [
  { kind: "issues-page-compact", query: "view=compact&includeRoutineExecutions=true&limit=100&offset=0" },
  { kind: "issues-page-index", query: "view=index&includeRoutineExecutions=true&limit=100&offset=0" },
  { kind: "list-all-page", query: "view=compact&limit=500&sortField=id&sortDir=asc" },
] as const;

type Arm = "before" | "after";
type Sample = { ms: number; status: number; cache: string | null; bodySha256: string; rowIds: string[] };

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { n: sorted.length, medianMs: round(at(0.5)), p90Ms: round(at(0.9)), meanMs: round(mean), minMs: round(sorted[0]!), maxMs: round(sorted.at(-1)!) };
}

async function timedGet(base: string, companyId: string, query: string, token: string): Promise<Sample> {
  const start = performance.now();
  const response = await fetch(`${base}/api/companies/${companyId}/issues?${query}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const body = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - start;
  let rowIds: string[] = [];
  if (response.ok) {
    const rows = JSON.parse(body.toString("utf8")) as Array<{ id: string }>;
    assert.ok(Array.isArray(rows), "The task list must answer an array");
    rowIds = rows.map((row) => row.id);
  }
  return { ms, status: response.status, cache: response.headers.get("x-paperclip-request-cache"), bodySha256: createHash("sha256").update(body).digest("hex"), rowIds };
}

async function health(base: string) {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200, `${base}/api/health`);
  const body = await response.json() as { commit?: string; memberRestriction?: string; deploymentMode?: string };
  return { commit: body.commit ?? null, memberRestriction: body.memberRestriction ?? null, deploymentMode: body.deploymentMode ?? null };
}

async function main() {
  const bases: Record<Arm, string | undefined> = { before: arg("before"), after: arg("after") };
  assert.ok(bases.before && bases.after, "Pass --before=<server before stage C> and --after=<server under test>");
  const token = process.env.MEASURE_OWNER_TOKEN;
  assert.ok(token, "Set MEASURE_OWNER_TOKEN to the owner's board key used by the seed");
  const companyId = arg("company-id") ?? SEEDED_COMPANY_ID;
  const runs = Number(arg("runs") ?? 100);
  const warmup = Number(arg("warmup") ?? 10);
  const maxSlowdown = Number(arg("max-slowdown") ?? 0.1);
  const minGapMs = Number(arg("min-gap-ms") ?? 2500);
  assert.ok(Number.isInteger(runs) && runs >= 5 && Number.isInteger(warmup) && warmup >= 0, "--runs >= 5 and --warmup >= 0");

  const servers = { before: await health(bases.before), after: await health(bases.after) };
  assert.equal(servers.after.memberRestriction === "forced_off", false, "The kill switch is on for the after server; unset PAPERCLIP_MEMBER_RESTRICTION");
  const started = new Date().toISOString();
  const samples = new Map<string, Record<Arm, Sample[]>>(TASK_LIST_REQUESTS.map((request) => [request.kind, { before: [], after: [] }]));
  const bodyHashes = new Map<string, Record<Arm, Set<string>>>(TASK_LIST_REQUESTS.map((request) => [request.kind, { before: new Set(), after: new Set() }]));

  const lastSent = new Map<string, number>();
  for (let round = 0; round < warmup + runs; round++) {
    const order: Arm[] = round % 2 ? ["after", "before"] : ["before", "after"];
    for (const request of TASK_LIST_REQUESTS) {
      const got = {} as Record<Arm, Sample>;
      for (const arm of order) {
        const key = `${arm} ${request.kind}`;
        const wait = (lastSent.get(key) ?? 0) + minGapMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        got[arm] = await timedGet(bases[arm]!, companyId, request.query, token);
        // The cache entry expires TTL after the response is built, so the gap counts from here.
        lastSent.set(key, Date.now());
      }
      for (const arm of order) {
        assert.equal(got[arm].status, 200, `${arm} ${request.kind}: HTTP ${got[arm].status}`);
        assert.ok(got[arm].cache === null || got[arm].cache === "miss", `${arm} ${request.kind}: served from the list cache (${got[arm].cache}); raise --min-gap-ms`);
      }
      assert.deepEqual(got.after.rowIds, got.before.rowIds, `${request.kind}: both servers must list the same rows in the same order`);
      assert.ok(got.before.rowIds.length > 0, `${request.kind}: the owner's list is empty; seed the company first`);
      if (round < warmup) continue;
      for (const arm of order) {
        samples.get(request.kind)![arm].push(got[arm]);
        bodyHashes.get(request.kind)![arm].add(got[arm].bodySha256);
      }
    }
  }

  const results = TASK_LIST_REQUESTS.map((request) => {
    const before = summarize(samples.get(request.kind)!.before.map((sample) => sample.ms));
    const after = summarize(samples.get(request.kind)!.after.map((sample) => sample.ms));
    const hashes = bodyHashes.get(request.kind)!;
    const ratio = Math.round((after.medianMs / before.medianMs) * 1000) / 1000;
    return {
      kind: request.kind,
      query: request.query,
      rows: samples.get(request.kind)!.before[0]!.rowIds.length,
      sameRowsAndOrder: true,
      identicalBody: hashes.before.size === 1 && hashes.after.size === 1 && [...hashes.before][0] === [...hashes.after][0],
      before,
      after,
      medianRatio: ratio,
      p90Ratio: Math.round((after.p90Ms / before.p90Ms) * 1000) / 1000,
      pass: ratio <= 1 + maxSlowdown,
      samplesMs: {
        before: samples.get(request.kind)!.before.map((sample) => Math.round(sample.ms * 100) / 100),
        after: samples.get(request.kind)!.after.map((sample) => Math.round(sample.ms * 100) / 100),
      },
    };
  });
  const report = { label: arg("label") ?? null, companyId, started, finished: new Date().toISOString(), runs, warmup, minGapMs, maxSlowdown, servers, node: process.version, results };
  const out = arg("out");
  if (out) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--assert")) {
    const failed = results.filter((result) => !result.pass);
    assert.equal(failed.length, 0, `Slower than ${Math.round(maxSlowdown * 100)} percent: ${failed.map((result) => `${result.kind} x${result.medianRatio}`).join(", ")}`);
  }
}

await main();
