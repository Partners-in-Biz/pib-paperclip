import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Db } from "@paperclipai/db";
import { invites } from "@paperclipai/db";

/**
 * PiB host patch (PAR-5230). Fork-only: keep this file and its single call site
 * in `better-auth.ts` self-contained so an upstream merge cannot conflict.
 *
 * When `auth.disableSignUp` is on, Better Auth's own flag would refuse every
 * `POST /sign-up/email`, which also blocks a new client owner who holds a valid
 * invite. So `better-auth.ts` leaves Better Auth's flag off and installs this
 * `before` hook instead. The hook keeps sign-up closed (same 400 and error code
 * Better Auth returns) unless the request carries an `inviteToken` for an invite
 * that is all of: a human company invite, not revoked, not accepted, not expired,
 * and issued for the very email being registered (`defaultsPayload.invitedEmail`).
 *
 * The hook only lets the account be created. It grants no instance role and no
 * company access: that still happens through `POST /invites/:token/accept`.
 * A repeat sign-up for the same email is refused by Better Auth itself (the user
 * exists), so one invite creates at most one account.
 */

export const INVITE_SIGNUP_TOKEN_FIELD = "inviteToken";
export const INVITE_EMAIL_DEFAULTS_KEY = "invitedEmail";

const SIGN_UP_PATH = "/sign-up/email";

function hashToken(token: string) {
  // Same digest as `hashToken` in routes/access.ts (invites.tokenHash).
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function signUpClosed(): APIError {
  // Identical for every refusal reason so the response is not an oracle for
  // which tokens or emails exist.
  return APIError.from("BAD_REQUEST", {
    message: "Email and password sign up is not enabled",
    code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  });
}

export async function inviteAllowsSignUp(
  db: Db,
  input: { token: unknown; email: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  const email = normalizeEmail(input.email);
  if (!email) return false;
  if (typeof input.token !== "string" || input.token.trim().length === 0) return false;

  const invite = await db
    .select()
    .from(invites)
    .where(eq(invites.tokenHash, hashToken(input.token.trim())))
    .then((rows) => rows[0] ?? null);

  if (!invite) return false;
  if (invite.inviteType !== "company_join" || !invite.companyId) return false;
  if (invite.allowedJoinTypes === "agent") return false;
  if (invite.revokedAt || invite.acceptedAt) return false;
  if (invite.expiresAt.getTime() <= now.getTime()) return false;

  const defaults = invite.defaultsPayload;
  const invitedEmail =
    defaults && typeof defaults === "object" && !Array.isArray(defaults)
      ? normalizeEmail((defaults as Record<string, unknown>)[INVITE_EMAIL_DEFAULTS_KEY])
      : null;
  return invitedEmail !== null && invitedEmail === email;
}

export function createInviteSignUpGate(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== SIGN_UP_PATH) return;
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const allowed = await inviteAllowsSignUp(db, {
      token: body[INVITE_SIGNUP_TOKEN_FIELD],
      email: body.email,
    });
    if (!allowed) throw signUpClosed();
  });
}
