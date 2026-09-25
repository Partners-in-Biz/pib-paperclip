export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

export interface Delegation {
  canRead: boolean;
  canDraft: boolean;
  canSend: boolean;
}

export function assertMayDraft(delegation: Delegation | null): void {
  if (!delegation?.canDraft) throw new MailboxError("This agent is not allowed to draft on that mailbox");
}

export function assertMaySend(delegation: Delegation | null): void {
  if (!delegation?.canSend) throw new MailboxError("This delegation is draft-only");
}

export function defaultDelegation(): Delegation {
  return { canRead: true, canDraft: true, canSend: false };
}
