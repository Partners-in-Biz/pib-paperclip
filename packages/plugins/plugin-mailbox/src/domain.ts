import { randomUUID } from "node:crypto";

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

export interface EmailTemplateDraft {
  id: string;
  companyId: string;
  name: string;
  subject: string;
  body: string;
}

export function createEmailTemplate(input: {
  companyId: string;
  name: string;
  subject: string;
  body?: string;
  id?: string;
}): EmailTemplateDraft {
  const name = input.name.trim();
  if (!name) throw new MailboxError("Template name is required");
  const subject = input.subject.trim();
  if (!subject) throw new MailboxError("Template subject is required");
  return {
    id: input.id ?? randomUUID(),
    companyId: input.companyId,
    name,
    subject,
    body: (input.body ?? "").trim(),
  };
}
