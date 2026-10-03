/**
 * How agents ask a person for something (browser-safe). Appended to every PiB
 * skill after the company memory section (`withFrontmatter`), and backed by
 * the Cockpit's `ask-owner` tool: the issue goes to the owner, the ask shows
 * in the Cockpit's "Waiting on you" and the daily brief, and the owner's reply
 * on the issue hands it back to the agent and wakes it.
 */
import { COMPANY_OS_SKILL_KEY } from "./team.js";

export const ASK_OWNER_TOOL = "partnersinbiz.cockpit:ask-owner";

/** Every ask-owner comment starts with this (the Cockpit writes it; a plugin's done-check spots the ask by it). */
export const ASK_OWNER_COMMENT_MARK = "**Question for the owner";

/** True when a comment is a question the Cockpit put to the owner (first ask or update). */
export function isAskOwnerComment(body: string | null | undefined): boolean {
  return typeof body === "string" && body.trimStart().startsWith(ASK_OWNER_COMMENT_MARK);
}

export const ASKING_HEADING = "## Asking a person";

export const ASKING_SECTION = `${ASKING_HEADING}

- Ask only for **money, legal, one-time grants** (a login consent, a key, a DNS record) or **real judgement**. Anything else: decide, do it and say so.
- Outward work (posts, emails, invoices, quotes, launches) goes through its module's request or approval tool, not a question.
- Otherwise call \`${ASK_OWNER_TOOL}\` once per issue: the question, options (your recommendation first), why it matters, a link to the exact screen and the steps. It shows in "Waiting on you" and the daily brief; their reply wakes you.
- Never ask in a comment or @-mention, and never assign issues to people. While you wait, do what doesn't depend on the answer.
- Before setting \`blocked\`, name what unblocks it (\`unblockDescriptor\`) or ask; else it is escalated after 24 h.
`;

/** Appends the asking section once. */
export function withAskingSection(body: string): string {
  if (body.includes(ASKING_HEADING)) return body;
  return `${body.trimEnd()}\n\n${ASKING_SECTION}`;
}

/** Skill key and slug of the company operating manual every PiB agent carries (a Cockpit managed skill). */
export const COMPANY_OS_SKILL = { key: COMPANY_OS_SKILL_KEY, slug: "pib-company-os" } as const;

/** One line for a hire's AGENTS.md next to the memory line. */
export const COMPANY_OS_INSTRUCTION =
  `Company operating manual: read the \`${COMPANY_OS_SKILL.slug}\` skill before your first task in a session and whenever work crosses modules. Ask a person only for money, legal, one-time grants or judgement, with \`${ASK_OWNER_TOOL}\` or the module's approval tool.`;

// ---------------------------------------------------------------------------
// Ask cards: what every ask must carry
// ---------------------------------------------------------------------------

export interface AskLinkLike {
  label: string;
  href: string;
}

export interface AskCardLike {
  kind: string;
  links?: AskLinkLike[] | null;
  steps?: string[] | null;
  /** The effect the ask applies once answered (kit `registerAskEffect`). */
  effect?: { key?: string | null } | null;
}

/** Ask kinds where the owner must do something on one particular screen. */
export const ASK_KINDS_NEEDING_SCREEN: readonly string[] = ["grant", "money", "legal"];

/** True for a path that only opens one issue (`/PIB/issues/PIB-12`): the ask's own home, not the screen to act on. */
export function isIssueLink(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? "";
  return /\/issues\/[^/]+\/?$/.test(path);
}

/**
 * Problems with an ask card, each worded for the agent that sent it. Empty when
 * the card is fine. The Cockpit's `ask-owner` refuses a card that has any:
 * without a deep link the owner has to hunt for the screen, and the Operator's
 * mailbox grant was asked five times in five days and never done.
 */
export function askCardProblems(card: AskCardLike): string[] {
  const problems: string[] = [];
  const links = (card.links ?? []).filter((link) => link && typeof link.href === "string" && link.href.trim());
  if (links.length === 0) {
    problems.push("Add at least one link: a Paperclip path (/<prefix>/settings/..., /<prefix>/mailbox) or an https address that opens the exact screen where the owner acts. For a plain decision, link the issue.");
  } else if (ASK_KINDS_NEEDING_SCREEN.includes(card.kind) && links.every((link) => isIssueLink(link.href))) {
    problems.push(`A ${card.kind} ask must link the exact screen the owner uses (the plugin's settings page, the provider's console page), not only this issue.`);
  }
  if (card.kind === "grant" && (card.steps ?? []).filter((step) => step && step.trim()).length === 0) {
    problems.push("A grant ask needs steps: the exact clicks, in order, so the owner does it once without asking you again.");
  }
  if (card.effect?.key && card.kind !== "grant" && card.kind !== "decision") {
    problems.push(`An ask with an effect (${card.effect.key}) is a grant or a decision, not ${card.kind}.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Blocked issues: the way out
// ---------------------------------------------------------------------------

/** Who unblocks the issue; mirrors the host's `unblockDescriptor.owner`. */
export type UnblockOwner = { agentId: string } | { userId: string } | "board";

/** What an agent states when it sets an issue to `blocked`; mirrors the host's `unblockDescriptor` plus the ask that carries it. */
export interface UnblockDescriptor {
  owner: UnblockOwner;
  /** One line: what has to happen for the issue to move again. */
  action: string;
  /** The `ask-owner` ask that asked the person, when there is one. */
  askId?: string | null;
}

/** Marks the machine-readable line in a blocked comment. */
export const UNBLOCK_MARK = "pib:unblock";

/** The comment an agent posts with a block: the reason, and a parseable unblock line. */
export function blockedComment(reason: string, descriptor: UnblockDescriptor): string {
  const owner = descriptor.owner === "board" ? "a board member" : "agentId" in descriptor.owner ? `agent ${descriptor.owner.agentId}` : `user ${descriptor.owner.userId}`;
  return [`**Blocked: ${reason.trim()}**`, "", `Unblocks when: ${descriptor.action.trim()} (${owner}).`, `<!-- ${UNBLOCK_MARK} ${JSON.stringify(descriptor)} -->`].join("\n");
}

/** The descriptor from a `blockedComment`, or null when the comment has none. */
export function parseBlockedComment(body: string | null | undefined): UnblockDescriptor | null {
  const match = typeof body === "string" ? body.match(new RegExp(`<!--\\s*${UNBLOCK_MARK}\\s+(\\{.*?\\})\\s*-->`, "s")) : null;
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]!) as Partial<UnblockDescriptor>;
    if (typeof value.action !== "string" || !value.action.trim()) return null;
    const owner = value.owner;
    const ownerOk = owner === "board" || (!!owner && typeof owner === "object" && (typeof (owner as { agentId?: unknown }).agentId === "string" || typeof (owner as { userId?: unknown }).userId === "string"));
    return ownerOk ? ({ owner, action: value.action.trim(), askId: typeof value.askId === "string" ? value.askId : null } as UnblockDescriptor) : null;
  } catch {
    return null;
  }
}

export interface BlockedIssueLike {
  unblockDescriptor?: { owner?: unknown; action?: unknown } | null;
  blockedBy?: unknown[] | null;
  scheduledRetry?: unknown;
  activeRecoveryAction?: unknown;
  /** A person holds it, so it is in their queue. */
  assigneeUserId?: string | null;
}

export type UnblockPath = "descriptor" | "blocked-by" | "ask" | "comment" | "retry" | "recovery" | "person";

/**
 * How a blocked issue gets unblocked, or null when nothing will: the host's own
 * `unblockDescriptor`, an issue it waits on, an open ask, a block comment with a
 * descriptor, a scheduled retry or a recovery action, or a person who holds it.
 * A blocked issue with none is invisible: 19 of 20 blocked PAR issues and all
 * 14 PARA ones were. (The host's issue list carries neither the retry nor the
 * recovery field, so those two only fire on a row read some other way; a block
 * waiting on a pending interaction shows only through the 24 h threshold.)
 */
export function unblockPath(issue: BlockedIssueLike, extra: { hasOpenAsk?: boolean; comments?: Array<string | null | undefined> } = {}): UnblockPath | null {
  const descriptor = issue.unblockDescriptor;
  if (descriptor && typeof descriptor.action === "string" && descriptor.action.trim()) return "descriptor";
  if (Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0) return "blocked-by";
  if (extra.hasOpenAsk) return "ask";
  if ((extra.comments ?? []).some((comment) => parseBlockedComment(comment) || isAskOwnerComment(comment))) return "comment";
  if (issue.scheduledRetry) return "retry";
  if (issue.activeRecoveryAction) return "recovery";
  if (typeof issue.assigneeUserId === "string" && issue.assigneeUserId.trim()) return "person";
  return null;
}
