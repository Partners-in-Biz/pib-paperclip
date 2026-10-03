/**
 * The owner confirmations (sign-up closed, backup key custody, a second admin,
 * a backup of the Mac), against a real Postgres: what Setup shows, what the
 * Confirm button does and who may press it, and when a confirmation lapses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extraChecks } from "../src/checks.js";
import { NAMESPACE } from "../src/namespace.js";
import { ownSetupStatus } from "../src/own.js";
import { saveTeam } from "../src/roles.js";
import { ATTEST_VALID_DAYS, ATTESTATIONS, attestationChecks, attestationSetupItems, attestationState, adminCount, confirmAttestation, readAttestations, singleAdminCheck, type AttestationRow } from "../src/security.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "22222222-2222-4222-8222-222222222222";
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-03T12:00:00.000Z");

describe("the confirmations as data", () => {
  it("every confirmation says what is at risk, what to do, and where; the four the critic named exist", () => {
    expect(ATTESTATIONS.map((a) => a.key)).toEqual(["signup_closed", "backup_key_custody", "second_admin", "mac_backup"]);
    for (const a of ATTESTATIONS) {
      expect(a.why.length, a.key).toBeGreaterThan(40);
      expect(a.steps.length, a.key).toBeGreaterThan(0);
      expect(a.confirmLabel, a.key).not.toBe("");
    }
    // the sign-up step names the real script and the caveat the lockdown has for invited people
    expect(ATTESTATIONS[0]!.steps.join(" ")).toContain("apply-signup-lockdown.sh");
    expect(ATTESTATIONS[0]!.steps.join(" ")).toContain("cannot accept an invite");
  });

  it("is confirmed for 180 days, then missing again", () => {
    const row = (confirmedAt: string | null, expiresAt: string | null): AttestationRow => ({ key: "signup_closed", confirmedBy: "u", confirmedAt, note: null, expiresAt });
    expect(attestationState(undefined, NOW)).toBe("missing");
    expect(attestationState(row(null, null), NOW)).toBe("missing");
    expect(attestationState(row("2026-09-01T00:00:00Z", "2027-02-28T00:00:00Z"), NOW)).toBe("confirmed");
    expect(attestationState(row("2026-01-01T00:00:00Z", "2026-06-30T00:00:00Z"), NOW)).toBe("expired");
    expect(ATTEST_VALID_DAYS).toBe(180);
  });

  it("one warning per missing confirmation, naming the days when it lapsed", () => {
    const rows = new Map<string, AttestationRow>([["signup_closed", { key: "signup_closed", confirmedBy: "u", confirmedAt: "2025-01-01T00:00:00Z", note: null, expiresAt: "2025-06-30T00:00:00Z" }]]);
    const checks = attestationChecks(rows, NOW);
    expect(checks.map((c) => c.key)).toEqual(["attest:signup_closed", "attest:backup_key_custody", "attest:second_admin", "attest:mac_backup"]);
    expect(checks[0]!.detail).toContain("Confirmed on 2025-01-01, which was more than 180 days ago");
    expect(checks[1]!.detail).toContain("Not confirmed yet.");
    expect(checks.every((c) => c.status === "warn" && !!c.fix)).toBe(true);
  });

  it("Setup items are optional (they never hold up Finish setup), carry a Confirm button until confirmed and none afterwards", () => {
    const rows = new Map<string, AttestationRow>([["mac_backup", { key: "mac_backup", confirmedBy: "u", confirmedAt: NOW.toISOString(), note: null, expiresAt: "2027-04-01T00:00:00Z" }]]);
    const items = attestationSetupItems(rows, NOW);
    expect(items.every((i) => i.required === false)).toBe(true);
    const signup = items.find((i) => i.key === "attest_signup_closed")!;
    expect(signup).toMatchObject({ status: "missing", action: { plugin: "partnersinbiz.cockpit", key: "cockpit.attest", params: { key: "signup_closed" }, label: "Sign-up is closed" } });
    const mac = items.find((i) => i.key === "attest_mac_backup")!;
    expect(mac).toMatchObject({ status: "done", action: null });
    expect(mac.detail).toContain("Confirmed on 2026-10-03");
  });

  it("counts only active human owners and admins", () => {
    expect(adminCount([
      { principalType: "user", status: "active", membershipRole: "owner" },
      { principalType: "user", status: "active", membershipRole: "admin" },
      { principalType: "user", status: "suspended", membershipRole: "admin" },
      { principalType: "agent", status: "active", membershipRole: "admin" },
      { principalType: "user", status: "active", membershipRole: "member" },
    ])).toBe(2);
    expect(singleAdminCheck(0, false)!.title).toBe("No owner or admin could be read for this company");
    expect(singleAdminCheck(1, false)!.title).toBe("Only one person can administer this company");
    expect(singleAdminCheck(1, true)).toBeNull();
    expect(singleAdminCheck(2, false)).toBeNull();
  });
});

d("the confirmations in the Cockpit (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    const w = await worlds.make({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" }, agents: [{ id: OP, companyId: A, name: "Olive", status: "active", role: "general" }] });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }
  const act = (w: Hybrid, params: Record<string, unknown>, actor: Record<string, unknown> = { type: "user", userId: "user-owner" }, companyId: string = A) =>
    w.actions.get("cockpit.attest")!(params, { companyId, actor }) as Promise<{ confirmed: AttestationRow }>;
  const stored = async (w: Hybrid, companyId = A) => (await w.client.query(`SELECT key, confirmed_by, note, expires_at FROM ${NAMESPACE}.attestations WHERE company_id = $1 ORDER BY key`, [companyId])).rows as Array<Record<string, any>>;

  it("the Confirm button records who confirmed and when it lapses, and the warning and the Setup button go away at once", async () => {
    const w = await make();
    const before = await extraChecks(w.env, A, { fresh: true });
    expect(before.health.filter((c) => c.key.startsWith("attest:"))).toHaveLength(4);
    const setupBefore = (await ownSetupStatus(w.env, A)).items.find((i) => i.key === "attest_signup_closed")!;
    expect(setupBefore).toMatchObject({ status: "missing", required: false });
    const out = await act(w, { key: "signup_closed", note: "Ran --verify on the server" });
    expect(out.confirmed).toMatchObject({ key: "signup_closed", confirmedBy: "user-owner", note: "Ran --verify on the server", confirmedAt: NOW.toISOString() });
    const [row] = await stored(w);
    expect(row).toMatchObject({ key: "signup_closed", confirmed_by: "user-owner" });
    expect(new Date(row!.expires_at).toISOString()).toBe("2027-04-01T12:00:00.000Z"); // 180 days on
    // the cache was dropped: the very next read already has it
    expect((await extraChecks(w.env, A)).health.filter((c) => c.key.startsWith("attest:")).map((c) => c.key)).toEqual(["attest:backup_key_custody", "attest:second_admin", "attest:mac_backup"]);
    expect((await ownSetupStatus(w.env, A)).items.find((i) => i.key === "attest_signup_closed")).toMatchObject({ status: "done", action: null });
  });

  it("an agent can never confirm: only a signed-in board user can, and an unknown key is refused", async () => {
    const w = await make();
    await expect(act(w, { key: "signup_closed" }, { type: "agent", agentId: OP })).rejects.toThrow("Only a board user can confirm this");
    await expect(act(w, { key: "signup_closed" }, { type: "user" })).rejects.toThrow("Sign in as a board user to confirm this");
    await expect(act(w, { key: "the_moon_is_cheese" })).rejects.toThrow(/Unknown confirmation "the_moon_is_cheese". It is one of signup_closed, backup_key_custody, second_admin, mac_backup/);
    await expect(w.actions.get("cockpit.attest")!({ key: "signup_closed" }, { actor: { type: "user", userId: "user-owner" } })).rejects.toThrow();
    expect(await stored(w)).toEqual([]);
  });

  it("an ask-owner question cannot carry the reserved effect, so no yes can confirm one", async () => {
    const w = await make();
    const issue = await w.ctx.issues.create({ companyId: A, title: "x", description: "", status: "in_progress", assigneeAgentId: OP } as never);
    const r = (await w.tools.get("ask-owner")!(
      { issueId: issue.id, question: "Is sign-up closed?", why: "Confirming.", kind: "decision", options: ["Yes", "No"], links: [{ label: "Setup", href: "/PAR/setup" }], effect: { key: "cockpit.attest", params: { key: "signup_closed" } } },
      { agentId: OP, runId: "r", companyId: A, projectId: "" },
    )) as { error?: string };
    expect(r.error).toContain("is not an effect an agent may ask for");
    expect(await stored(w)).toEqual([]);
  });

  it("reconfirming replaces the record (and its new expiry); another company's confirmations are separate", async () => {
    const w = await make();
    await act(w, { key: "second_admin" });
    w.clock.set("2026-12-01T12:00:00.000Z");
    await act(w, { key: "second_admin" }, { type: "user", userId: "user-deputy" });
    await confirmAttestation(w.env, B, "mac_backup", "user-b");
    const rows = await stored(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "second_admin", confirmed_by: "user-deputy" });
    expect(new Date(rows[0]!.expires_at).toISOString().slice(0, 10)).toBe("2027-05-30");
    expect([...(await readAttestations(w.ctx, B)).keys()]).toEqual(["mac_backup"]);
    expect((await readAttestations(w.ctx, A)).has("mac_backup")).toBe(false);
  });

  it("asks again when the confirmation has lapsed", async () => {
    const w = await make();
    for (const a of ATTESTATIONS) await confirmAttestation(w.env, A, a.key, "user-owner");
    expect((await extraChecks(w.env, A, { fresh: true })).health.filter((c) => c.key.startsWith("attest:"))).toEqual([]);
    w.clock.set("2027-04-02T12:00:00.000Z");
    const lapsed = (await extraChecks(w.env, A, { fresh: true })).health.filter((c) => c.key.startsWith("attest:"));
    expect(lapsed).toHaveLength(4);
    expect(lapsed[0]!.detail).toContain("more than 180 days ago");
    expect((await ownSetupStatus(w.env, A)).items.find((i) => i.key === "attest_mac_backup")).toMatchObject({ status: "missing" });
  });
});
