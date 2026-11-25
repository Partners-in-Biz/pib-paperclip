/**
 * Access look-up through the real tools: access-check (each of its three
 * answers), access-request (one child issue, and each refusal) and
 * access-grant (the deciding seat carries the decision out), plus the
 * inventory route. A fake host, no Postgres.
 */
import { describe, expect, it } from "vitest";
import { ensureLookupTools, readAccessSettings, runAccessTool, settleAccessRequests } from "../src/access.js";
import { parseBindLine } from "../src/access-model.js";
import { ORIGIN } from "../src/constants.js";
import { createEnv, handleApiRoute, registerCockpit } from "../src/register.js";
import { COCKPIT_TOOLS } from "../src/tools.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "cccccccc-0000-4000-8000-000000000001";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000d1";
const REN = "aaaaaaaa-0000-4000-8000-0000000000d2";
const PIB = "aaaaaaaa-0000-4000-8000-0000000000b2";
const SIPHO = "aaaaaaaa-0000-4000-8000-0000000000b3";
const S_SAGA = "11111111-0000-4000-8000-000000000001";
const S_VERCEL = "11111111-0000-4000-8000-000000000002";
const S_PAYFAST = "11111111-0000-4000-8000-000000000003";
const STUDIO = "partnersinbiz.studio:studio-usage";
const CRM = "partnersinbiz.crm:find-records";
const MEMORY = "partnersinbiz.cockpit:memory-recall";
const CHECK = "partnersinbiz.cockpit:access-check";
const REQUEST = "partnersinbiz.cockpit:access-request";
const GRANT = "partnersinbiz.cockpit:access-grant";

const INVENTORY = {
  generatedAt: "2026-11-11T17:50:00.000Z",
  secrets: [
    { id: S_SAGA, name: "SA Gun Auctions SSH login", key: "sa-gun-auctions-ssh", description: "SSH for the SAGA site", value: "hunter2-never-shown" },
    { id: S_VERCEL, name: "VERCEL_TOKEN", key: "vercel-token" },
    { id: S_PAYFAST, name: "PayFast merchant key", key: "payfast-merchant-key" },
  ],
  tools: [STUDIO, CRM, "partnersinbiz.billing:find-records", MEMORY, CHECK, REQUEST, GRANT],
  profiles: [
    {
      id: "22222222-0000-4000-8000-000000000001",
      profileKey: "creative-producer-studio",
      name: "Creative Producer: Studio",
      status: "active",
      defaultAction: "deny",
      bindings: [{ targetType: "agent", targetId: REN }],
      entries: [{ selectorType: "tool_name", effect: "include", toolName: STUDIO, conditions: null }],
    },
  ],
};

type Result = { content: string; data: Record<string, any>; error?: string };

async function setup(options: { config?: Record<string, unknown>; inventory?: boolean } = {}) {
  const fake = fakeCtx({
    savedConfigs: { [A]: options.config ?? { decisionRights: { seats: { access: PIB } }, access: { boardQueueIssue: "PAR-9356", neverGrant: ["owner mailbox"] } } },
    prefixes: { [A]: "PAR" },
    agents: [
      { id: DEV, companyId: A, name: "Dev", status: "active", adapterConfig: { env: { NODE_ENV: { type: "plain", value: "production" } } } },
      { id: REN, companyId: A, name: "Ren", status: "active", title: "Creative Producer", adapterConfig: { env: { VERCEL_TOKEN: { type: "secret_ref", secretId: S_VERCEL, version: "latest" } } } },
      { id: PIB, companyId: A, name: "PiB", status: "active", role: "ceo" },
      { id: SIPHO, companyId: A, name: "Sipho", status: "active" },
      { id: "aaaaaaaa-0000-4000-8000-0000000000ff", companyId: A, name: "Old Hand", status: "terminated" },
    ],
  });
  fake.grants.set(DEV, [
    { permissionKey: "tasks:assign", scope: null },
    { permissionKey: "tools:use", scope: { toolNames: [MEMORY] } },
  ]);
  fake.grants.set(SIPHO, [
    { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } },
    { permissionKey: "agents:configure", scope: null },
  ]);
  fake.grants.set(PIB, [{ permissionKey: "tools:use", scope: { toolNames: [MEMORY, CHECK, REQUEST, GRANT] } }]);
  const clock = fixedClock("2026-11-11T18:00:00.000Z");
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  fake.issues.set("task-1", { id: "task-1", companyId: A, identifier: "PAR-100", title: "Deploy the SAGA site", description: "", status: "in_progress", assigneeAgentId: DEV, priority: "high", projectId: "proj-1" });
  fake.issues.set("queue", { id: "queue", companyId: A, identifier: "PAR-9356", title: "Board queue", description: "", status: "in_progress" });
  const tool = (name: string, params: Record<string, unknown>, agentId = DEV) => runAccessTool(env, name, params, { companyId: A, agentId, runId: "run-1", projectId: "" }) as Promise<Result>;
  const push = (inventory: unknown = INVENTORY) => handleApiRoute(env, { routeKey: "access-inventory", companyId: A, body: { companyId: A, inventory } } as never);
  if (options.inventory !== false) expect((await push()).status).toBe(200);
  const requests = () => [...fake.issues.values()].filter((i) => i.originKind === ORIGIN.access);
  return { ...fake, env, clock, tool, push, requests };
}

describe("the tools are declared", () => {
  it("as access-check, access-request and access-grant", () => {
    const names = COCKPIT_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["access-check", "access-request", "access-grant"]));
  });
});

describe("access-check: may a seat use a tool", () => {
  it("says yes by grant, for me and for a named seat", async () => {
    const s = await setup();
    const mine = await s.tool("access-check", { tool: MEMORY });
    expect(mine.error).toBeUndefined();
    expect(mine.content).toMatch(/^Yes\. You \(Dev\) may use partnersinbiz\.cockpit:memory-recall: its tools grant names this tool\./);
    const other = await s.tool("access-check", { tool: "studio-usage", seat: "Sipho" });
    expect(other.content).toMatch(/^Yes\. Sipho may use partnersinbiz\.studio:studio-usage: its tools grant covers every plugin tool\./);
    expect(other.data.toolAnswer).toMatchObject({ allowed: true, via: "grant-plugin-tools" });
  });
  it("says yes through a tool profile bound to the seat (found by title too)", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { tool: STUDIO, seat: "creative producer" });
    expect(answer.content).toContain('Yes. Ren may use partnersinbiz.studio:studio-usage: the tool profile "Creative Producer: Studio" allows it.');
  });
  it("says no, who has it, which profile includes it and which seat decides", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { tool: STUDIO });
    expect(answer.error).toBeUndefined();
    expect(answer.content).toContain("No. You (Dev) have no grant and no tool profile for partnersinbiz.studio:studio-usage.");
    expect(answer.content).toContain("Seats that can use it now: Ren, Sipho.");
    expect(answer.content).toContain('Tool profiles that include it: "Creative Producer: Studio".');
    expect(answer.content).toContain('PiB decides this (access that already exists); it does not go to the owner. Call access-request with kind "tool", name "partnersinbiz.studio:studio-usage"');
    expect(answer.data.toolAnswer).toMatchObject({ allowed: false, verdict: "deny", seatsWithIt: [{ name: "Ren" }, { name: "Sipho" }] });
  });
  it("is unclear, not no, when the profiles have not been sent", async () => {
    const s = await setup({ inventory: false });
    const answer = await s.tool("access-check", { tool: STUDIO });
    expect(answer.content).toMatch(/^Unclear\. You \(Dev\) have no tools grant that covers/);
    expect(answer.content).toContain("The server has not sent the list of tool profiles yet");
    expect(answer.content).toContain("Try the tool once");
    const short = await s.tool("access-check", { tool: "studio-usage" });
    expect(short.content).toContain("Pass the full tool name");
  });
  it("says when no tool has that name, with close names", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { tool: "find-records" });
    expect(answer.content).toContain('More than one plugin has a tool called "find-records"');
    expect(answer.content).toContain("partnersinbiz.crm:find-records");
  });
  it("says so when the list is old", async () => {
    const s = await setup();
    s.clock.set("2026-11-12T09:00:00.000Z");
    const answer = await s.tool("access-check", { tool: STUDIO });
    expect(answer.content).toContain("was read 15 hours ago");
  });
  it("needs a question and a seat that exists", async () => {
    const s = await setup();
    const mine = await s.tool("access-check", {});
    expect(mine.error).toBeUndefined();
    expect(mine.content).toContain("You (Dev), as it stands now:");
    expect(mine.content).toContain("- Plugin tools: partnersinbiz.cockpit:access-check, partnersinbiz.cockpit:access-request, partnersinbiz.cockpit:memory-recall.");
    expect(mine.content).toContain("- Permissions: tasks:assign.");
    const ren = await s.tool("access-check", { seat: "Ren" });
    expect(ren.content).toContain('Tool profiles: "Creative Producer: Studio".');
    expect(ren.content).toContain("attached (the value is in the environment variable of the seat's runs): VERCEL_TOKEN.");
    expect((await s.tool("access-check", { seat: "Sipho" })).content).toContain("- Plugin tools: every plugin tool");
    expect((await s.tool("access-check", { tool: STUDIO, seat: "Old Hand" })).error).toContain('No active seat is called "Old Hand"');
  });
});

describe("access-check: is a secret stored, and where", () => {
  it("names the secret and the seats that have it, never a value", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { secret: "vercel" });
    expect(answer.content).toContain('Yes. The company holds a stored secret matching "vercel"');
    expect(answer.content).toContain('- "VERCEL_TOKEN" (key vercel-token): attached to Ren as VERCEL_TOKEN');
    expect(answer.content).toContain('You (Dev) do not have "VERCEL_TOKEN". PiB decides this');
    expect(answer.data.secretAnswer.matches[0]).toMatchObject({ id: S_VERCEL, attachedTo: [{ seat: "Ren", env: "VERCEL_TOKEN" }] });
    const all = JSON.stringify(answer) + JSON.stringify([...s.state.values()]);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("production");
  });
  it("says the seat already has it and where to read it", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { secret: "VERCEL_TOKEN", seat: "Ren" });
    expect(answer.content).toContain('Ren already has "VERCEL_TOKEN": it is in the environment variable VERCEL_TOKEN');
    expect(answer.data.secretAnswer.seatHasIt).toBe(true);
  });
  it("finds a stored secret no seat has, the case that used to reach the owner", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { secret: "gun auctions ssh" });
    expect(answer.content).toContain('- "SA Gun Auctions SSH login" (key sa-gun-auctions-ssh): attached to no seat');
    expect(answer.content).toContain('Call access-request with kind "secret", name "SA Gun Auctions SSH login"');
  });
  it("sends a payment credential to the owner", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { secret: "payfast" });
    expect(answer.content).toContain("owner only");
    expect(answer.content).toContain("only the owner can attach it, because it looks like a payment or banking credential");
  });
  it("says no when nothing matches, and that a new credential is a hard stop", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { secret: "cloudflare" });
    expect(answer.content).toMatch(/^No\. The company holds no stored secret matching "cloudflare" \(3 names checked/);
    expect(answer.content).toContain("hard stop");
  });
  it("without the list, says it cannot tell and points at environment names", async () => {
    const s = await setup({ inventory: false });
    const answer = await s.tool("access-check", { secret: "vercel" });
    expect(answer.content).toContain("are not available right now");
    expect(answer.content).toContain("Ren (VERCEL_TOKEN)");
  });
});

describe("access-check: which seats hold a permission", () => {
  it("lists the holders and says whether the seat is one", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { permission: "agents:configure" });
    expect(answer.content).toContain("1 seat holds agents:configure: Sipho. You (Dev) do not hold it.");
    expect(answer.content).toContain("put one line on PAR-9356");
    const tools = await s.tool("access-check", { permission: "tools:use", seat: "Sipho" });
    expect(tools.content).toContain("3 seats hold tools:use: Dev (limited), PiB (limited), Sipho (limited). Sipho holds it.");
  });
  it("says when nobody holds it and names the close ones", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { permission: "agents:create" });
    expect(answer.content).toContain('No seat holds "agents:create". Close permissions in use: agents:configure.');
  });
  it("answers all three in one call", async () => {
    const s = await setup();
    const answer = await s.tool("access-check", { tool: MEMORY, secret: "vercel", permission: "tasks:assign" });
    expect(Object.keys(answer.data)).toEqual(expect.arrayContaining(["toolAnswer", "secretAnswer", "permissionAnswer"]));
  });
});

describe("access-request", () => {
  const ask = { issueId: "PAR-100", kind: "tool", name: "studio-usage", error: "deny_default: No effective tool profile, grant, or allow policy permits this call. token=abc123456789", why: "The usage report for the Studio." };

  it("opens ONE child issue for the deciding seat, blocks the task on it and links it", async () => {
    const s = await setup();
    const result = await s.tool("access-request", ask);
    expect(result.error).toBeUndefined();
    const [request] = s.requests();
    expect(s.requests()).toHaveLength(1);
    expect(request).toMatchObject({ assigneeAgentId: PIB, parentId: "task-1", status: "todo", projectId: "proj-1", title: "Access request: Dev needs the tool partnersinbiz.studio:studio-usage" });
    expect(request!.description).toContain(`- Seat: Dev (\`${DEV}\`)`);
    expect(request!.description).toContain("- Tool: `partnersinbiz.studio:studio-usage`");
    expect(request!.description).toContain("[PAR-100](/PAR/issues/PAR-100): Deploy the SAGA site");
    expect(request!.description).toContain("> deny_default: No effective tool profile");
    expect(request!.description).not.toContain("abc123456789");
    expect(request!.description).toContain("partnersinbiz.cockpit:access-grant");
    expect(s.issues.get("task-1")).toMatchObject({ status: "blocked", blockedByIssueIds: [request!.id] });
    expect(s.wakeups).toContain(request!.id);
    expect(s.comments.find((c) => c.issueId === "task-1")!.body).toContain("**Access request with PiB**");
    expect(result.content).toMatch(/^Asked PiB on PIB-\d+\. PAR-100 is blocked on it/);
    expect(result.data).toMatchObject({ created: true, blocked: true, kind: "tool", name: STUDIO, decidedBy: { name: "PiB" } });
  });
  it("joins the open request instead of opening a second one", async () => {
    const s = await setup();
    await s.tool("access-request", ask);
    s.issues.set("task-2", { id: "task-2", companyId: A, identifier: "PAR-101", title: "Another task", description: "", status: "in_progress", assigneeAgentId: DEV });
    const again = await s.tool("access-request", { ...ask, issueId: "PAR-101" });
    expect(s.requests()).toHaveLength(1);
    expect(again.data.created).toBe(false);
    expect(again.content).toMatch(/^Already asked: PiB has it on/);
    expect(s.comments.some((c) => c.issueId === s.requests()[0]!.id && c.body.includes("Another task needs the same access"))).toBe(true);
    expect(s.issues.get("task-2")!.status).toBe("blocked");
  });
  it("refuses when the tool is already allowed, and says what to do instead", async () => {
    const s = await setup();
    const result = await s.tool("access-request", { ...ask, name: MEMORY });
    expect(result.error).toMatch(/^Not needed: the access already exists\. Yes\. You \(Dev\) may use partnersinbiz\.cockpit:memory-recall/);
    expect(result.error).toContain("quote the exact error");
    expect(s.requests()).toHaveLength(0);
    expect(s.issues.get("task-1")!.status).toBe("in_progress");
  });
  it("refuses when the secret is already attached to the seat", async () => {
    const s = await setup();
    const result = await s.tool("access-request", { issueId: "PAR-100", kind: "secret", name: "VERCEL_TOKEN", error: "401", seat: "Ren" });
    expect(result.error).toContain('Not needed: Ren already has "VERCEL_TOKEN" attached, as the environment variable VERCEL_TOKEN');
    expect(s.requests()).toHaveLength(0);
  });
  it("asks for a stored secret by its exact name, with the environment name it will get", async () => {
    const s = await setup();
    const result = await s.tool("access-request", { issueId: "PAR-100", kind: "secret", name: "SA Gun Auctions SSH login", error: "Permission denied (publickey,password)." });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ kind: "secret", name: "SA Gun Auctions SSH login", envName: "SA_GUN_AUCTIONS_SSH" });
    expect(s.requests()[0]!.description).toContain(`Stored secret: "SA Gun Auctions SSH login" (key \`sa-gun-auctions-ssh\`, id \`${S_SAGA}\`), to be attached as \`SA_GUN_AUCTIONS_SSH\``);
    expect(s.requests()[0]!.originId).toBe(`cockpit:access:secret:${DEV}:${S_SAGA}:SA_GUN_AUCTIONS_SSH`);
  });
  it("refuses a payment credential, a name that matches nothing, a loose name and a taken environment name", async () => {
    const s = await setup();
    const base = { issueId: "PAR-100", kind: "secret", error: "401" };
    expect((await s.tool("access-request", { ...base, name: "PayFast merchant key" })).error).toContain("Only the owner can attach it");
    expect((await s.tool("access-request", { ...base, name: "cloudflare" })).error).toContain("there is nothing to attach");
    expect((await s.tool("access-request", { ...base, name: "e" })).error ?? "").toMatch(/Pass the exact name of one|nothing to attach/);
    expect((await s.tool("access-request", { ...base, name: "VERCEL_TOKEN", envName: "NODE_ENV" })).error).toContain("already has an environment variable called NODE_ENV");
    expect((await s.tool("access-request", { ...base, name: "VERCEL_TOKEN", envName: "lower" })).error).toContain("envName must be");
    expect(s.requests()).toHaveLength(0);
  });
  it("refuses a tool on the company's never-grant list", async () => {
    const s = await setup({ config: { decisionRights: { seats: { access: PIB } }, access: { neverGrant: ["studio-usage"] } } });
    expect((await s.tool("access-request", ask)).error).toContain("only the owner can give it, because it is on the company's never-grant list");
  });
  it("refuses the deciding seat's own request, a company with no deciding seat, and a closed or missing task", async () => {
    const s = await setup();
    expect((await s.tool("access-request", { ...ask, seat: "PiB" })).error).toContain("PiB decides access for other seats, never for its own");
    expect((await s.tool("access-request", { ...ask, issueId: "PAR-999" })).error).toContain("was not found");
    s.issues.get("task-1")!.status = "done";
    expect((await s.tool("access-request", ask)).error).toContain("is closed");
    const none = await setup({ config: {} });
    expect((await none.tool("access-request", ask)).error).toContain("No seat is set to decide access");
    expect((await s.tool("access-request", { issueId: "PAR-100", kind: "tool", name: STUDIO })).error).toContain("Pass issueId");
  });
});

describe("access-grant", () => {
  async function requested(kind: "tool" | "secret" = "tool") {
    const s = await setup();
    const result = await s.tool(
      "access-request",
      kind === "tool" ? { issueId: "PAR-100", kind, name: STUDIO, error: "deny_default" } : { issueId: "PAR-100", kind, name: "SA Gun Auctions SSH login", envName: "SAGA_SSH", error: "Permission denied" },
    );
    expect(result.error).toBeUndefined();
    return { s, request: s.requests()[0]! };
  }

  it("is only for the deciding seat", async () => {
    const { s, request } = await requested();
    const result = await s.tool("access-grant", { requestIssueId: request.id, reason: "I want it" }, DEV);
    expect(result.error).toContain("Only PiB decides access");
    expect(s.grants.get(DEV)).toHaveLength(2);
  });
  it("a yes for a tool adds that one tool, keeps the seat's other grants, logs a line and closes the request", async () => {
    const { s, request } = await requested();
    const result = await s.tool("access-grant", { requestIssueId: request.identifier, decision: "yes", reason: "PAR-100 needs the usage report." }, PIB);
    expect(result.error).toBeUndefined();
    expect(s.grants.get(DEV)).toEqual([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "tools:use", scope: { toolNames: [MEMORY, CHECK, REQUEST, STUDIO] } },
    ]);
    expect(s.issues.get(request.id)!.status).toBe("done");
    const onRequest = s.comments.filter((c) => c.issueId === request.id).map((c) => c.body);
    expect(onRequest.at(-1)).toMatch(/^DECISION \(access that already exists\): yes, PAR-100 needs the usage report\./);
    const onTask = s.comments.filter((c) => c.issueId === "task-1").map((c) => c.body);
    expect(onTask.at(-1)).toContain("ACCESS GRANTED: Dev may use `partnersinbiz.studio:studio-usage` (named in its tools grant) for PAR-100. Decided by PiB: PAR-100 needs the usage report.");
    const check = await s.tool("access-check", { tool: STUDIO });
    expect(check.content).toMatch(/^Yes\. You \(Dev\) may use/);
  });
  it("a no closes the request with the reason and changes nothing", async () => {
    const { s, request } = await requested();
    const before = JSON.stringify(s.grants.get(DEV));
    const result = await s.tool("access-grant", { requestIssueId: request.id, decision: "no", reason: "Ren owns Studio work: hand it over." }, PIB);
    expect(result.content).toContain("Recorded: no.");
    expect(JSON.stringify(s.grants.get(DEV))).toBe(before);
    expect(s.issues.get(request.id)!.status).toBe("done");
    expect(s.comments.filter((c) => c.issueId === request.id).at(-1)!.body).toBe("DECISION (access that already exists): no, Ren owns Studio work: hand it over.");
    expect(s.comments.filter((c) => c.issueId === "task-1").at(-1)!.body).toContain("**Access not given** by PiB");
  });
  it("a yes for a stored secret puts one fixed-format line on the board queue and parks the request there", async () => {
    const { s, request } = await requested("secret");
    const result = await s.tool("access-grant", { requestIssueId: request.id, reason: "The SAGA deploy needs the login." }, PIB);
    expect(result.error).toBeUndefined();
    const lines = s.comments.filter((c) => c.issueId === "queue").map((c) => c.body);
    expect(lines).toHaveLength(1);
    expect(parseBindLine(lines[0]!)).toEqual({ agentId: DEV, envName: "SAGA_SSH", secretId: S_SAGA });
    expect(lines[0]).toContain(`BIND-SECRET: Dev gets "SA Gun Auctions SSH login" as SAGA_SSH for PAR-100 (request ${request.identifier}). Decided by PiB: The SAGA deploy needs the login.`);
    expect(s.issues.get(request.id)).toMatchObject({ status: "blocked", blockedByIssueIds: ["queue"] });
    expect(result.content).toContain("One line is on PAR-9356");
    // Deciding it twice does not post a second line.
    const again = await s.tool("access-grant", { requestIssueId: request.id, reason: "Same." }, PIB);
    expect(again.content).toContain("The line was already on PAR-9356");
    expect(s.comments.filter((c) => c.issueId === "queue")).toHaveLength(1);
  });
  it("closes the secret request by itself once the board attached it", async () => {
    const { s, request } = await requested("secret");
    await s.tool("access-grant", { requestIssueId: request.id, reason: "Needed." }, PIB);
    expect(await settleAccessRequests(s.env, A)).toEqual([]);
    const dev = s.agents.find((a) => a.id === DEV)!;
    dev.adapterConfig = { env: { ...(dev.adapterConfig!.env as object), SAGA_SSH: { type: "secret_ref", secretId: S_SAGA, version: "latest" } } };
    const pushed = await s.push();
    expect((pushed.body as { settled: string[] }).settled).toEqual([request.identifier]);
    expect(s.issues.get(request.id)!.status).toBe("done");
    expect(s.comments.filter((c) => c.issueId === request.id).at(-1)!.body).toContain('**Attached.** Dev now has "SA Gun Auctions SSH login" as the environment variable `SAGA_SSH`');
  });
  it("refuses a payment credential even for the deciding seat, and its own seat", async () => {
    const s = await setup();
    const money = await s.tool("access-grant", { seat: "Dev", kind: "secret", name: "PayFast merchant key", issueId: "PAR-100", reason: "Checkout test." }, PIB);
    expect(money.error).toContain("is not for an agent to give: it looks like a payment or banking credential");
    expect(s.comments.filter((c) => c.issueId === "queue")).toHaveLength(0);
    const own = await s.tool("access-grant", { seat: "PiB", kind: "tool", name: STUDIO, issueId: "PAR-100", reason: "Mine." }, PIB);
    expect(own.error).toContain("cannot give access to its own seat");
  });
  it("gives access with no request, and wakes the task", async () => {
    const s = await setup();
    const result = await s.tool("access-grant", { seat: "Dev", kind: "tool", name: "studio-usage", issueId: "PAR-100", reason: "Sweep: the task needs it." }, PIB);
    expect(result.content).toContain("Granted. Dev may now use partnersinbiz.studio:studio-usage.");
    expect(s.wakeups).toContain("task-1");
    expect(s.requests()).toHaveLength(0);
  });
  it("settles a request whose access is already in place, without changing anything", async () => {
    const { s, request } = await requested();
    s.grants.set(DEV, [{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
    const result = await s.tool("access-grant", { requestIssueId: request.id, reason: "Fine." }, PIB);
    expect(result.content).toContain("Nothing to change");
    expect(s.issues.get(request.id)!.status).toBe("done");
    expect(s.grants.get(DEV)).toEqual([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]);
  });
  it("does not widen a grant limited some other way, and says where it goes", async () => {
    const { s, request } = await requested();
    s.grants.set(DEV, [{ permissionKey: "tools:use", scope: { connectionId: "c1" } }]);
    const result = await s.tool("access-grant", { requestIssueId: request.id, reason: "Needed." }, PIB);
    expect(result.error).toContain("which only the board can change");
    expect(result.error).toContain("Put one line on PAR-9356");
    expect(s.issues.get(request.id)!.status).toBe("todo");
  });
  it("says so when no board queue is set for a secret, and changes nothing", async () => {
    const s = await setup({ config: { decisionRights: { seats: { access: PIB } } } });
    const result = await s.tool("access-grant", { seat: "Dev", kind: "secret", name: "SA Gun Auctions SSH login", issueId: "PAR-100", reason: "Needed." }, PIB);
    expect(result.error).toContain("no open board queue issue is set");
  });
  it("needs a reason, a known request and a valid decision", async () => {
    const { s, request } = await requested();
    expect((await s.tool("access-grant", { requestIssueId: request.id }, PIB)).error).toContain("Pass reason");
    expect((await s.tool("access-grant", { requestIssueId: request.id, decision: "maybe", reason: "x" }, PIB)).error).toContain('decision must be "yes" or "no"');
    expect((await s.tool("access-grant", { requestIssueId: "PAR-100", reason: "x" }, PIB)).error).toContain("is not an access request");
    await s.tool("access-grant", { requestIssueId: request.id, decision: "no", reason: "No." }, PIB);
    expect((await s.tool("access-grant", { requestIssueId: request.id, reason: "x" }, PIB)).error).toContain("already decided and closed");
  });
});

describe("the inventory route", () => {
  it("refuses a bad body and a company that does not match", async () => {
    const s = await setup({ inventory: false });
    expect((await s.push({ secrets: [] })).status).toBe(400);
    const other = await handleApiRoute(s.env, { routeKey: "access-inventory", companyId: A, body: { companyId: "someone-else", inventory: INVENTORY } } as never);
    expect(other.status).toBe(400);
  });
  it("stores names only and reports what it took", async () => {
    const s = await setup({ inventory: false });
    const pushed = await s.push();
    expect(pushed.body).toMatchObject({ ok: true, secrets: 3, tools: 7, profiles: 1, generatedAt: "2026-11-11T17:50:00.000Z" });
    expect(JSON.stringify([...s.state.values()])).not.toContain("hunter2");
  });
  it("adds the look-up tools to grants that name their tools, and to the deciding seat, and to nobody else", async () => {
    const s = await setup({ inventory: false });
    s.grants.set(PIB, [{ permissionKey: "tools:use", scope: { toolNames: [MEMORY] } }]);
    const pushed = await s.push();
    expect((pushed.body as { lookupToolsAddedTo: string[] }).lookupToolsAddedTo.sort()).toEqual(["Dev", "PiB"]);
    expect(s.grants.get(DEV)).toEqual([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "tools:use", scope: { toolNames: [MEMORY, CHECK, REQUEST] } },
    ]);
    expect(s.grants.get(PIB)).toEqual([{ permissionKey: "tools:use", scope: { toolNames: [MEMORY, CHECK, REQUEST, GRANT] } }]);
    expect(s.grants.get(SIPHO)![0]).toEqual({ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } });
    expect(s.grants.has(REN)).toBe(false);
    // A second pass changes nothing.
    expect(await ensureLookupTools(s.env, A, await readAccessSettings(s.env, A))).toEqual([]);
  });
  it("leaves grants alone when the company switched that off", async () => {
    const s = await setup({ config: { decisionRights: { seats: { access: PIB } }, access: { grantLookupTools: false } }, inventory: false });
    const pushed = await s.push();
    expect((pushed.body as { lookupToolsAddedTo: string[] }).lookupToolsAddedTo).toEqual([]);
    expect(s.grants.get(DEV)![1]).toEqual({ permissionKey: "tools:use", scope: { toolNames: [MEMORY] } });
  });
});
