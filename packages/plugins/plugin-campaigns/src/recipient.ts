/**
 * The one seam between an enrollment's recipient id and the person behind it
 * (plan PAR-9192 rev 2, section 5.5, alternative E2).
 *
 * An enrollment's `contact_id` holds either a CRM contact id (the CRM copy in
 * `crm_contacts`, as today) or, later, `member:<id>` for a person on a client's
 * list in Campaigns. CRM contact ids are host-made (a UUID, or `canary-...` for
 * the CRM canary) and never start with `member:`, so the prefix alone says
 * which kind an id is.
 *
 * Stage 4a ships contacts only: a `member:` id resolves to nothing, so the send
 * paths treat it as they treat an unknown contact (email hands the step to a
 * person, SMS/WhatsApp skips it) and nothing goes out.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getCrmContact } from "@partnersinbiz/pib-plugin-kit";

export const MEMBER_PREFIX = "member:";

export type RecipientKind = "contact" | "member";

export interface Recipient {
  /** The id as the enrollment stores it. */
  id: string;
  kind: RecipientKind;
  name: string;
  emails: string[];
  phones: string[];
  /** CRM companies the person belongs to (empty for a member). */
  account_ids: string[];
}

export function recipientKind(recipientId: string): RecipientKind {
  return recipientId.startsWith(MEMBER_PREFIX) ? "member" : "contact";
}

/** The person behind an enrollment's recipient id, or null when unknown (or a member, not resolved yet). */
export async function resolveRecipient(ctx: PluginContext, companyId: string, recipientId: string): Promise<Recipient | null> {
  if (recipientKind(recipientId) === "member") return null;
  const contact = await getCrmContact(ctx, ctx.db.namespace, companyId, recipientId);
  if (!contact) return null;
  return {
    id: contact.id,
    kind: "contact",
    name: contact.name,
    emails: contact.emails ?? [],
    phones: contact.phones ?? [],
    account_ids: contact.account_ids ?? [],
  };
}
