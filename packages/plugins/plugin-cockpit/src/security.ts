/**
 * Things only the owner can confirm, and the single points of failure the
 * critic found (custody, sign-up, one admin).
 *
 * Paperclip's API shows none of these: whether board sign-up is open is read
 * once from the server config and exposed nowhere; where the backup key is kept
 * is a fact about the owner's password manager; the instance admins and the
 * server's SSH keys are not visible to a plugin. So the Cockpit cannot check
 * them. What it can do is refuse to forget: each is an owner confirmation with
 * an expiry (180 days), shown as a Setup item with a Confirm button and as a
 * health warning until it is confirmed, and asked for again when it lapses.
 *
 * The one thing it CAN read is the company's members (`access.members.read`):
 * a company with a single owner or admin is a single point of failure, and the
 * Cockpit says so until a second person is added (or the owner confirms a
 * deputy exists).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit/cockpit";
import type { SetupItem } from "@partnersinbiz/pib-plugin-kit/setup";
import { PLUGIN_KEY } from "./constants.js";
import type { Env } from "./env.js";
import { CockpitError, message } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.attestations`;

/** A confirmation lasts this long, then the owner is asked again (a custody fact can change). */
export const ATTEST_VALID_DAYS = 180;

export interface AttestationDef {
  key: string;
  title: string;
  /** What is at risk, one or two sentences (for the health check and the setup item). */
  why: string;
  /** What the owner does, in order. */
  steps: string[];
  /** What the owner confirms with the button. */
  confirmLabel: string;
  /** What the agents do once it is confirmed. */
  agentNext: string;
  href: string | null;
  hrefLabel: string | null;
}

export const ATTESTATIONS: AttestationDef[] = [
  {
    key: "signup_closed",
    title: "Confirm board sign-up is closed",
    why: "While sign-up is open anyone on the internet can create an account on the Paperclip board, which holds every company's secrets. The setting is read from the server's configuration and is not visible here.",
    steps: [
      "On the server, run apply-signup-lockdown.sh --check (see operations/vps/docs/security.md, decision 4), then --apply --owner-approved.",
      "Restart Paperclip in the maintenance window (it ends in-flight agent runs), then run apply-signup-lockdown.sh --verify.",
      "Come back here and confirm. Note: with sign-up closed a person who has no account yet cannot accept an invite until it is opened again.",
    ],
    confirmLabel: "Sign-up is closed",
    agentNext: "Nothing: the warning clears. The Operator no longer lists it on the brief.",
    href: null,
    hrefLabel: null,
  },
  {
    key: "backup_key_custody",
    title: "Confirm the backup key is stored outside your Mac",
    why: "Every off-site backup is encrypted, and the private key that opens them lives on one Mac. If that Mac is lost, no backup can be read and the company cannot be restored.",
    steps: [
      "Put a copy of ~/.config/pib-paperclip/backup-age-key.txt in your password manager.",
      "Prove it works: decrypt the newest off-site bundle using the copy from the password manager (docs/RESTORE.md).",
      "Optionally keep a second sealed copy with a person you trust. Then confirm here.",
    ],
    confirmLabel: "The backup key is stored outside the Mac",
    agentNext: "Nothing: the warning clears.",
    href: null,
    hrefLabel: null,
  },
  {
    key: "second_admin",
    title: "Confirm a second break-glass admin and SSH key exist",
    why: "One person is the only instance admin, and both root SSH keys on the server are theirs. If that person is unreachable nobody can restore, approve a deploy or fix the server.",
    steps: [
      "Add a trusted deputy as a second instance admin in Paperclip (Settings, Access).",
      "Add the deputy's SSH public key to the server's root authorized_keys, and keep a way to remove it.",
      "Write down who the deputy is where you keep the runbooks. Then confirm here.",
    ],
    confirmLabel: "A second admin and SSH key exist",
    agentNext: "Nothing: the warning clears.",
    href: "/company/settings",
    hrefLabel: "Open company settings",
  },
  {
    key: "mac_backup",
    title: "Confirm the Mac that holds the keys is backed up",
    why: "The Mac holds the backup key, the deploy scripts and unpushed work. It has no Time Machine destination, so its disk failing loses them.",
    steps: ["Turn on Time Machine to an external disk, or an off-site backup of the Mac.", "Check one restore of a file works. Then confirm here."],
    confirmLabel: "The Mac has a working backup",
    agentNext: "Nothing: the warning clears.",
    href: null,
    hrefLabel: null,
  },
];

export interface AttestationRow {
  key: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  note: string | null;
  expiresAt: string | null;
}

export type AttestationState = "confirmed" | "missing" | "expired";

export function attestationState(row: AttestationRow | undefined, now: Date): AttestationState {
  if (!row?.confirmedAt) return "missing";
  if (row.expiresAt && Date.parse(row.expiresAt) <= now.getTime()) return "expired";
  return "confirmed";
}

/** Health warnings for every confirmation that is missing or lapsed. */
export function attestationChecks(rows: Map<string, AttestationRow>, now: Date, options: { defs?: AttestationDef[] } = {}): HealthCheck[] {
  const out: HealthCheck[] = [];
  for (const def of options.defs ?? ATTESTATIONS) {
    const row = rows.get(def.key);
    const state = attestationState(row, now);
    if (state === "confirmed") continue;
    out.push({
      key: `attest:${def.key}`,
      title: def.title,
      status: "warn",
      detail: `${state === "expired" ? `Confirmed on ${row!.confirmedAt!.slice(0, 10)}, which was more than ${ATTEST_VALID_DAYS} days ago, so it needs confirming again. ` : "Not confirmed yet. "}${def.why}`,
      href: def.href ?? "/setup",
      fix: `${def.steps.join(" ")} Confirm it with the button on this item in Setup.`,
      since: row?.expiresAt ?? null,
    });
  }
  return out;
}

/** The Setup checklist items (optional: they never block the Finish setup count), each with a Confirm button. */
export function attestationSetupItems(rows: Map<string, AttestationRow>, now: Date, options: { defs?: AttestationDef[] } = {}): SetupItem[] {
  return (options.defs ?? ATTESTATIONS).map((def): SetupItem => {
    const row = rows.get(def.key);
    const state = attestationState(row, now);
    return {
      key: `attest_${def.key}`,
      title: def.title,
      status: state === "confirmed" ? "done" : "missing",
      required: false,
      detail: state === "confirmed" ? `Confirmed on ${row!.confirmedAt!.slice(0, 10)}; asked again after ${ATTEST_VALID_DAYS} days.` : `${state === "expired" ? "The last confirmation lapsed. " : ""}${def.why}`,
      href: def.href,
      hrefLabel: def.hrefLabel,
      steps: state === "confirmed" ? undefined : def.steps,
      agentNext: def.agentNext,
      action: state === "confirmed" ? null : { plugin: PLUGIN_KEY, key: "cockpit.attest", params: { key: def.key }, label: def.confirmLabel },
    };
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function readAttestations(ctx: PluginContext, companyId: string): Promise<Map<string, AttestationRow>> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT key, confirmed_by, confirmed_at, note, expires_at FROM ${T} WHERE company_id = $1`, [companyId]);
  const iso = (value: unknown): string | null => {
    if (value == null || value === "") return null;
    const t = Date.parse(String(value));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  return new Map(rows.map((r) => [String(r.key), { key: String(r.key), confirmedBy: r.confirmed_by == null ? null : String(r.confirmed_by), confirmedAt: iso(r.confirmed_at), note: r.note == null ? null : String(r.note), expiresAt: iso(r.expires_at) }]));
}

/** The owner confirms one thing. Only a person: the caller passes the user id, an agent never gets here. */
export async function confirmAttestation(env: Env, companyId: string, key: string, userId: string, note?: string | null): Promise<AttestationRow> {
  if (!ATTESTATIONS.some((d) => d.key === key)) throw new CockpitError(`Unknown confirmation "${key}". It is one of ${ATTESTATIONS.map((d) => d.key).join(", ")}.`);
  const now = env.now();
  const expires = new Date(now.getTime() + ATTEST_VALID_DAYS * 86_400_000).toISOString();
  await env.ctx.db.execute(
    `INSERT INTO ${T} (company_id, key, confirmed_by, confirmed_at, note, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, key) DO UPDATE SET confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at, note = EXCLUDED.note, expires_at = EXCLUDED.expires_at`,
    [companyId, key, userId, now.toISOString(), note ? note.slice(0, 300) : null, expires],
  );
  return { key, confirmedBy: userId, confirmedAt: now.toISOString(), note: note ?? null, expiresAt: expires };
}

// ---------------------------------------------------------------------------
// One owner, one admin
// ---------------------------------------------------------------------------

export interface MemberLite {
  principalType: string;
  status: string;
  membershipRole: string | null;
}

/** Active human owners and admins of the company. */
export function adminCount(members: MemberLite[]): number {
  return members.filter((m) => m.principalType === "user" && m.status === "active" && (m.membershipRole === "owner" || m.membershipRole === "admin")).length;
}

/**
 * A company with one owner or admin has one person who can approve, restore
 * and recover. A warning until a second is added, or the owner confirms a
 * deputy exists (the `second_admin` confirmation). The instance-level admin
 * list and the server's SSH keys are not readable from a plugin: say so.
 */
export function singleAdminCheck(count: number, confirmed: boolean): HealthCheck | null {
  if (count >= 2 || confirmed) return null;
  return {
    key: "access:single-admin",
    title: count === 0 ? "No owner or admin could be read for this company" : "Only one person can administer this company",
    status: "warn",
    detail: `${count === 0 ? "The company's members could not be read as owner or admin." : "Exactly one active owner or admin."} If that person is unreachable nobody can approve, restore or recover. The Cockpit cannot see the instance-level admins or the server's SSH keys, so this reads the company's own members only.`,
    href: "/company/settings",
    fix: "Add a trusted deputy as a second admin (Settings, Access). If a deputy already exists outside this list, confirm \"a second admin and SSH key exist\" in Setup.",
  };
}

/** The members check: null when members cannot be read (the capability is missing or the host refused): then the confirmation is all there is. */
export async function membersCheck(env: Env, companyId: string, confirmed: boolean): Promise<HealthCheck | null> {
  try {
    const access = (env.ctx as unknown as { access?: { members?: { list: (input: { companyId: string }) => Promise<MemberLite[]> } } }).access;
    if (!access?.members) return null;
    return singleAdminCheck(adminCount(await access.members.list({ companyId })), confirmed);
  } catch (error) {
    env.ctx.logger.info("Cockpit members unreadable", { companyId, error: message(error) });
    return null;
  }
}
