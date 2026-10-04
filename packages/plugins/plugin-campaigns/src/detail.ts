/**
 * What the campaign detail view says (pure, no React or Node imports, so the
 * UI and tests share it): delivery and timing in plain words, the approval
 * state, and when the next email goes out.
 */

export type Delivery = "issue" | "email" | "auto";

/** The Delivery column and the new-campaign choice. */
export const DELIVERY_LABEL: Record<Delivery, string> = {
  issue: "Task for the agent",
  email: "Email through the Mailbox",
  auto: "Automatic: email, SMS, WhatsApp",
};

/** One line on how a due email goes out. */
export const DELIVERY_DETAIL: Record<Delivery, string> = {
  issue: "Each due email opens a task, and the campaign's agent sends it.",
  email: "The Mailbox sends each due email by itself, as the sender below, with an unsubscribe link.",
  auto: "Each due step goes out by itself on its own channel: email through the Mailbox, SMS and WhatsApp through the messaging provider, inside the send window.",
};

export function deliveryKey(delivery: string | null | undefined): Delivery {
  return delivery === "email" ? "email" : delivery === "auto" ? "auto" : "issue";
}

export function deliveryLabel(delivery: string | null | undefined): string {
  return DELIVERY_LABEL[deliveryKey(delivery)];
}

/**
 * When a step goes out. The first step counts from the launch (or the start
 * date); every later step counts from when the step before it (number
 * `previous`) was sent.
 */
export function stepTiming(delayDays: number, previous: number | null): string {
  const days = Math.max(0, Math.round(delayDays));
  const span = `${days} ${days === 1 ? "day" : "days"}`;
  if (previous === null) return days === 0 ? "Goes out at launch" : `${span} after launch`;
  return days === 0 ? `Straight after step ${previous}` : `${span} after step ${previous}`;
}

export interface StepLike {
  position: number;
  delayDays: number;
  subject: string;
  body: string;
  htmlBody?: string | null;
  variant?: "a" | "b";
  channel?: "email" | "sms" | "whatsapp";
}

/** Steps in send order, numbered 1, 2, 3… with their A and B versions together. */
export function orderedSteps<T extends StepLike>(steps: T[]): Array<{ number: number; position: number; timing: string; a: T; b: T | null }> {
  const positions = [...new Set(steps.map((step) => step.position))].sort((x, y) => x - y);
  const out: Array<{ number: number; position: number; timing: string; a: T; b: T | null }> = [];
  for (const position of positions) {
    const a = steps.find((step) => step.position === position && step.variant !== "b") ?? steps.find((step) => step.position === position)!;
    const b = steps.find((step) => step.position === position && step.variant === "b") ?? null;
    const number = out.length + 1;
    out.push({ number, position, timing: stepTiming(a.delayDays, number === 1 ? null : number - 1), a, b: b === a ? null : b });
  }
  return out;
}

/** The first `max` characters of a body on word boundaries, and whether it was cut. */
export function bodyPreview(body: string | null | undefined, max = 280): { text: string; cut: boolean } {
  const clean = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return { text: clean, cut: false };
  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  return { text: `${(lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`, cut: true };
}

export interface ApprovalLike {
  status: string;
  approvalIssueId: string | null;
  approvalStatus: string | null;
  launchError?: string | null;
  launchedAt?: string | null;
}

export type ApprovalKey = "not-requested" | "waiting" | "approved" | "could-not-launch" | "launched" | "none";

/** Where the campaign's approval stands, from the approver's point of view. */
export function approvalState(campaign: ApprovalLike): { key: ApprovalKey; label: string } {
  if (campaign.status !== "draft") {
    return campaign.approvalIssueId || campaign.launchedAt ? { key: "launched", label: "Approved and launched" } : { key: "none", label: "Launched" };
  }
  if (!campaign.approvalIssueId) return { key: "not-requested", label: "Not sent for approval yet" };
  if (campaign.launchError) return { key: "could-not-launch", label: "Approved, but it could not launch" };
  if (campaign.approvalStatus === "done") return { key: "approved", label: "Approved, launching" };
  return { key: "waiting", label: "Waiting for approval" };
}

/** A running enrollment, as the detail view reads it. */
export interface RunningEnrollment {
  stepPosition: number;
  nextDueAt: string | null;
  /** A step task is open: the agent has to send it. */
  waiting: boolean;
  /** The Mailbox is sending the step email now. */
  sending: boolean;
}

export interface NextSend {
  /** When the next queued step is due (ISO); in the past means it goes out within minutes. */
  at: string | null;
  stepPosition: number | null;
  /** Contacts due for that step within a day of `at`. */
  contacts: number;
  /** Steps whose task is open and waits for the agent. */
  waitingOnAgent: number;
  /** Step emails the Mailbox is sending now. */
  sending: number;
}

/** The next email out, from the running enrollments. */
export function nextSend(rows: RunningEnrollment[]): NextSend {
  const queued = rows
    .filter((row) => !row.waiting && !row.sending && row.nextDueAt && Number.isFinite(Date.parse(row.nextDueAt)))
    .sort((a, b) => Date.parse(a.nextDueAt!) - Date.parse(b.nextDueAt!));
  const first = queued[0] ?? null;
  const at = first ? Date.parse(first.nextDueAt!) : null;
  return {
    at: first?.nextDueAt ?? null,
    stepPosition: first?.stepPosition ?? null,
    contacts: first ? queued.filter((row) => row.stepPosition === first.stepPosition && Date.parse(row.nextDueAt!) - at! < 86_400_000).length : 0,
    waitingOnAgent: rows.filter((row) => row.waiting).length,
    sending: rows.filter((row) => row.sending).length,
  };
}
