/**
 * Access look-up: the pure rules (who may use a tool, secret name matching,
 * the never-grant rule, the grant merge and the board's bind line).
 */
import { describe, expect, it } from "vitest";
import {
  bindLine,
  envNameFor,
  findSecrets,
  mergeToolNames,
  neverGrant,
  parseAccessSettings,
  parseBindLine,
  parseInventory,
  parseRequestOriginId,
  profilesWithTool,
  requestOriginId,
  resolveTool,
  scopeVerdict,
  seatEnv,
  toolAnswer,
  type InvProfile,
} from "../src/access-model.js";

const CO = "cccccccc-0000-4000-8000-000000000001";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000d1";
const REN = "aaaaaaaa-0000-4000-8000-0000000000d2";
const S1 = "11111111-0000-4000-8000-000000000001";
const TOOL = "partnersinbiz.studio:studio-usage";

function profile(over: Partial<InvProfile> = {}): InvProfile {
  return {
    id: "22222222-0000-4000-8000-000000000001",
    key: "creative-producer-studio",
    name: "Creative Producer: Studio",
    active: true,
    defaultAction: "deny",
    bindings: [{ targetType: "agent", targetId: REN }],
    entries: [{ selectorType: "tool_name", effect: "include", toolName: TOOL, conditional: false }],
    ...over,
  };
}

describe("scopeVerdict (mirrors the host's scopeAllowsTool)", () => {
  it("allows with no scope and with an empty scope", () => {
    expect(scopeVerdict(null, TOOL, DEV)).toBe("allow");
    expect(scopeVerdict({}, TOOL, DEV)).toBe("allow");
  });
  it("allows every plugin tool for the plugin provider type, and no other provider", () => {
    expect(scopeVerdict({ providerType: "paperclip_plugin" }, TOOL, DEV)).toBe("allow");
    expect(scopeVerdict({ providerTypes: ["mcp", "paperclip_plugin"] }, TOOL, DEV)).toBe("allow");
    expect(scopeVerdict({ providerType: "mcp" }, TOOL, DEV)).toBe("deny");
  });
  it("allows only the named tools", () => {
    expect(scopeVerdict({ toolNames: [TOOL] }, TOOL, DEV)).toBe("allow");
    expect(scopeVerdict({ toolNames: ["partnersinbiz.cockpit:memory-recall"] }, TOOL, DEV)).toBe("deny");
    expect(scopeVerdict({ toolName: TOOL }, TOOL, DEV)).toBe("allow");
  });
  it("treats an allow list as a limit, like the host", () => {
    expect(scopeVerdict({ allow: [`tool:${TOOL}`] }, TOOL, DEV)).toBe("allow");
    expect(scopeVerdict({ allow: ["tool:other"] }, TOOL, DEV)).toBe("deny");
    expect(scopeVerdict({ allow: [] }, TOOL, DEV)).toBe("deny");
  });
  it("denies a malformed or unknown selector, and is unclear on one that depends on the run", () => {
    expect(scopeVerdict({ toolNames: "x" }, TOOL, DEV)).toBe("deny");
    expect(scopeVerdict({ somethingElse: "x" }, TOOL, DEV)).toBe("deny");
    expect(scopeVerdict({ projectId: "p1" }, TOOL, DEV)).toBe("unclear");
    expect(scopeVerdict({ projectId: "p1", toolNames: ["other"] }, TOOL, DEV)).toBe("deny");
  });
});

describe("toolAnswer", () => {
  it("says yes by grant before it looks at profiles", () => {
    const answer = toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants: [{ principalId: DEV, permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }], profiles: [] });
    expect(answer).toMatchObject({ verdict: "allow", via: "grant-plugin-tools" });
  });
  it("says yes through a profile bound to the seat, and no for a seat it is not bound to", () => {
    expect(toolAnswer({ toolName: TOOL, agentId: REN, companyId: CO, grants: [], profiles: [profile()] })).toMatchObject({ verdict: "allow", via: "profile", profile: "Creative Producer: Studio" });
    expect(toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants: [], profiles: [profile()] })).toMatchObject({ verdict: "deny", via: null });
  });
  it("ignores another seat's grant and a grant for another permission", () => {
    const grants = [
      { principalId: REN, permissionKey: "tools:use", scope: null },
      { principalId: DEV, permissionKey: "tasks:assign", scope: null },
    ];
    expect(toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants, profiles: [] }).verdict).toBe("deny");
  });
  it("uses a company profile only when the seat has none of its own, and skips an inactive or excluding one", () => {
    const company = profile({ id: "22222222-0000-4000-8000-000000000002", name: "Everyone", bindings: [{ targetType: "company", targetId: CO }] });
    expect(toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants: [], profiles: [company] }).verdict).toBe("allow");
    const own = profile({ name: "Own", bindings: [{ targetType: "agent", targetId: DEV }], entries: [] });
    expect(toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants: [], profiles: [company, own] }).verdict).toBe("deny");
    expect(toolAnswer({ toolName: TOOL, agentId: REN, companyId: CO, grants: [], profiles: [profile({ active: false })] }).verdict).toBe("deny");
    const excluding = profile({ defaultAction: "allow", entries: [{ selectorType: "tool_name", effect: "exclude", toolName: TOOL, conditional: false }] });
    expect(toolAnswer({ toolName: TOOL, agentId: REN, companyId: CO, grants: [], profiles: [excluding] }).verdict).toBe("deny");
  });
  it("is unclear when a rule cannot be judged from here", () => {
    const conditional = profile({ entries: [{ selectorType: "tool_name", effect: "include", toolName: TOOL, conditional: true }] });
    expect(toolAnswer({ toolName: TOOL, agentId: REN, companyId: CO, grants: [], profiles: [conditional] })).toMatchObject({ verdict: "unclear", unclearProfiles: ["Creative Producer: Studio"] });
    const perProject = profile({ bindings: [{ targetType: "project", targetId: "p1" }] });
    expect(toolAnswer({ toolName: TOOL, agentId: DEV, companyId: CO, grants: [], profiles: [perProject] }).verdict).toBe("unclear");
  });
  it("lists the profiles that include a tool", () => {
    expect(profilesWithTool([profile(), profile({ name: "Other", entries: [] })], TOOL)).toEqual([{ name: "Creative Producer: Studio", agentIds: [REN] }]);
  });
});

describe("resolveTool", () => {
  const known = ["partnersinbiz.studio:studio-usage", "partnersinbiz.crm:find-records", "partnersinbiz.billing:find-records"];
  it("takes the full name, and a short name only one plugin has", () => {
    expect(resolveTool("partnersinbiz.studio:studio-usage", known)).toEqual({ ok: true, name: TOOL, known: true });
    expect(resolveTool("studio-usage", known)).toEqual({ ok: true, name: TOOL, known: true });
  });
  it("refuses a short name two plugins share and a name nobody has, with close names", () => {
    const two = resolveTool("find-records", known);
    expect(two.ok).toBe(false);
    expect(!two.ok && two.suggestions).toEqual(["partnersinbiz.crm:find-records", "partnersinbiz.billing:find-records"]);
    const none = resolveTool("studio-usge", known);
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain('No plugin tool is called "studio-usge"');
  });
  it("with no tool list, takes a full name as written and asks for one otherwise", () => {
    expect(resolveTool(TOOL, [])).toEqual({ ok: true, name: TOOL, known: false });
    expect(resolveTool("studio-usage", []).ok).toBe(false);
  });
});

describe("mergeToolNames", () => {
  it("adds a named grant when the seat has no tools grant, and keeps every other grant", () => {
    const merged = mergeToolNames([{ permissionKey: "tasks:assign", scope: null }], [TOOL], DEV);
    expect(merged).toEqual({ grants: [{ permissionKey: "tasks:assign", scope: null }, { permissionKey: "tools:use", scope: { toolNames: [TOOL] } }], changed: true, conflict: null });
  });
  it("adds the name to a grant that names tools, once", () => {
    const merged = mergeToolNames([{ permissionKey: "tools:use", scope: { toolNames: ["a:b"] } }], [TOOL, "a:b"], DEV);
    expect(merged.changed).toBe(true);
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: { toolNames: ["a:b", TOOL] } }]);
  });
  it("changes nothing when the grant already covers it", () => {
    expect(mergeToolNames([{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }], [TOOL], DEV)).toMatchObject({ changed: false, conflict: null });
  });
  it("does not widen a grant limited some other way", () => {
    const merged = mergeToolNames([{ permissionKey: "tools:use", scope: { connectionId: "c1" } }], [TOOL], DEV);
    expect(merged.changed).toBe(false);
    expect(merged.conflict).toContain("only the board can change");
    expect(merged.grants).toEqual([{ permissionKey: "tools:use", scope: { connectionId: "c1" } }]);
  });
});

describe("secrets", () => {
  const secrets = [
    { id: S1, name: "SA Gun Auctions SSH login", key: "sa-gun-auctions-ssh", description: "SFTP and SSH for the SAGA site" },
    { id: "11111111-0000-4000-8000-000000000002", name: "VERCEL_TOKEN", key: "vercel-token", description: null },
    { id: "11111111-0000-4000-8000-000000000003", name: "Gundemy SFTP password", key: "gundemy-sftp", description: null },
  ];
  it("finds by exact name, by part of a name and by words in any order", () => {
    expect(findSecrets("VERCEL_TOKEN", secrets).map((s) => s.name)).toEqual(["VERCEL_TOKEN"]);
    expect(findSecrets("gun auctions", secrets).map((s) => s.name)).toEqual(["SA Gun Auctions SSH login"]);
    expect(findSecrets("ssh gun", secrets).map((s) => s.name)).toEqual(["SA Gun Auctions SSH login"]);
    expect(findSecrets("sftp", secrets).map((s) => s.name)).toEqual(["Gundemy SFTP password", "SA Gun Auctions SSH login"]);
    expect(findSecrets("stripe", secrets)).toEqual([]);
  });
  it("reads a seat's environment names and never a value", () => {
    const env = seatEnv({ id: DEV, adapterConfig: { env: { VERCEL_TOKEN: { type: "secret_ref", secretId: S1, version: "latest" }, NODE_ENV: { type: "plain", value: "production" }, RAW: "abc" } } });
    expect(env).toEqual({ agentId: DEV, refs: [{ env: "VERCEL_TOKEN", secretId: S1 }], plain: ["NODE_ENV", "RAW"] });
    expect(JSON.stringify(env)).not.toContain("production");
  });
  it("makes an environment name from the key", () => {
    expect(envNameFor({ key: "sa-gun-auctions-ssh", name: "x" })).toBe("SA_GUN_AUCTIONS_SSH");
    expect(envNameFor({ key: "9lives", name: "x" })).toBe("S_9LIVES");
  });
});

describe("neverGrant", () => {
  it("refuses payment and banking names, however they are written", () => {
    expect(neverGrant(["PAYFAST_MERCHANT_KEY"], [])?.reason).toBe("money");
    expect(neverGrant(["Standard Bank login"], [])?.reason).toBe("money");
    expect(neverGrant(["stripeSecretKey"], [])?.reason).toBe("money");
    expect(neverGrant(["Rebel Rags Ozow test key"], [])?.reason).toBe("money");
    expect(neverGrant(["SARS eFiling"], [])?.reason).toBe("money");
  });
  it("refuses personal logins and anything on the company's list", () => {
    expect(neverGrant(["Apple ID password"], [])?.reason).toBe("personal");
    expect(neverGrant(["Personal Gmail"], [])?.reason).toBe("personal");
    expect(neverGrant(["Peet's GitHub token"], ["peet"])).toEqual({ reason: "listed", match: "peet" });
    expect(neverGrant(["x", null, "owner mailbox"], ["Owner Mailbox"])?.reason).toBe("listed");
  });
  it("lets ordinary names through, and does not match inside a longer word", () => {
    expect(neverGrant(["SA Gun Auctions SSH login", "sa-gun-auctions-ssh"], [])).toBeNull();
    expect(neverGrant(["VERCEL_TOKEN", "PAYLOAD_SECRET", "DISCARD_KEY"], [])).toBeNull();
  });
});

describe("the board's bind line", () => {
  it("is one line in a fixed format that reads back", () => {
    const line = bindLine({ agentId: DEV, envName: "SAGA_SSH", secretId: S1, seatName: "Dev`\n#1", secretName: 'SA Gun "Auctions"', taskRef: "PAR-12", requestRef: "PAR-13", deciderName: "PiB", reason: "needs it\nfor the deploy" });
    expect(line).not.toContain("\n");
    expect(line.startsWith(`\`bind-secret.py ${DEV} SAGA_SSH=${S1}\` BIND-SECRET: `)).toBe(true);
    expect(line).toContain("for PAR-12 (request PAR-13). Decided by PiB: needs it for the deploy");
    expect(parseBindLine(line)).toEqual({ agentId: DEV, envName: "SAGA_SSH", secretId: S1 });
    expect(parseBindLine("bind-secret.py x y=z")).toBeNull();
  });
});

describe("inventory and settings", () => {
  it("keeps names and ids only: a value sent by mistake is dropped", () => {
    const inv = parseInventory(
      {
        generatedAt: "2026-11-11T18:00:00Z",
        secrets: [{ id: S1, name: " VERCEL_TOKEN ", key: "vercel-token", value: "sk-live-abc", providerMetadata: { arn: "x" } }, { id: "nope", name: "bad id" }, { id: S1 }],
        tools: [TOOL, TOOL, "not a tool name", 7],
        profiles: [{ id: "22222222-0000-4000-8000-000000000001", profileKey: "k", name: "P", status: "active", defaultAction: "deny", metadata: { token: "abc" }, bindings: [{ targetType: "agent", targetId: REN, extra: 1 }], entries: [{ selectorType: "tool_name", effect: "include", toolName: TOOL, conditions: { x: 1 } }] }],
      },
      "2026-11-11T18:01:00.000Z",
    );
    expect(inv.secrets).toEqual([{ id: S1, name: "VERCEL_TOKEN", key: "vercel-token", description: null }]);
    expect(inv.tools).toEqual([TOOL]);
    expect(inv.profiles[0]).toEqual({ id: "22222222-0000-4000-8000-000000000001", key: "k", name: "P", active: true, defaultAction: "deny", bindings: [{ targetType: "agent", targetId: REN }], entries: [{ selectorType: "tool_name", effect: "include", toolName: TOOL, conditional: true }] });
    expect(JSON.stringify(inv)).not.toMatch(/sk-live|arn|abc/);
    expect(() => parseInventory({ secrets: [] }, "x")).toThrow(/secrets, tools and profiles/);
  });
  it("round-trips through what is stored", () => {
    const first = parseInventory({ generatedAt: "2026-11-11T18:00:00Z", secrets: [{ id: S1, name: "A", key: "a" }], tools: [TOOL], profiles: [profile()] }, "2026-11-11T18:01:00.000Z");
    expect(parseInventory(first, first.receivedAt)).toEqual(first);
  });
  it("carries a request in its origin id", () => {
    const tool = requestOriginId({ kind: "tool", seatAgentId: DEV, toolName: TOOL });
    expect(parseRequestOriginId(tool)).toEqual({ kind: "tool", seatAgentId: DEV, toolName: TOOL });
    const secret = requestOriginId({ kind: "secret", seatAgentId: DEV, secretId: S1, envName: "SAGA_SSH" });
    expect(parseRequestOriginId(secret)).toEqual({ kind: "secret", seatAgentId: DEV, secretId: S1, envName: "SAGA_SSH" });
    expect(parseRequestOriginId("cockpit:decision:x")).toBeNull();
  });
  it("reads the settings and drops what is malformed", () => {
    expect(parseAccessSettings({ access: { boardQueueIssue: " par-9356 ", neverGrant: ["peet", "", 4, "peet"], grantLookupTools: false } }, DEV)).toEqual({ seatAgentId: DEV, boardQueueIssue: "PAR-9356", neverGrant: ["peet"], grantLookupTools: false });
    expect(parseAccessSettings({ access: { boardQueueIssue: "the board issue" } }, null)).toEqual({ seatAgentId: null, boardQueueIssue: null, neverGrant: [], grantLookupTools: true });
  });
});
