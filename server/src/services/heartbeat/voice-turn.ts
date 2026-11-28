import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { issueCommentMetadataSchema } from "@paperclipai/shared";
import { extractWakeCommentIds } from "../../modules/run-dispatch/domain/wake-context.js";
import { isConversation } from "../agent-conversations.js";
import { instanceSettingsService } from "../instance-settings.js";
import { restrictedAgentIdsForActor } from "../member-restriction/agent-read.js";
import { readVoiceRunProfileSetting, type VoiceRunProfileSetting } from "./voice-run-setting.js";

/**
 * Whether a run is a voice turn (plan PAR-15073 rev 3, 5.1 rules 1-4).
 *
 * Decided from stored facts only: the run row, its chat, the comments it wakes for, the voice plugin's
 * rows, the instance flag and the company setting. No caller passes a voice flag, so merged wakes,
 * outbox delivery, retries and recovery all meet the same rule. Every doubt (a missing row, a failed
 * read, a field in an unknown shape) gives a normal run, which is what every run is today.
 *
 * The answer can only make a run lighter for the person's own chat. It grants no access.
 *
 * Stage 1 (PAR-15299): nothing calls this yet. M3a calls it at slot selection and at claim.
 */

export type VoiceTurnRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "companyId"
  | "agentId"
  | "issueId"
  | "invocationSource"
  | "retryOfRunId"
  | "scheduledRetryReason"
  | "contextSnapshot"
  | "resultJson"
>;

/** Why a run is a normal run. One code per rule that failed, the first one checked. */
export type NormalRunReason =
  | "not_comment_wake"
  | "retry_or_recovery"
  | "flag_off"
  | "setting_off"
  | "not_chat"
  | "no_comments"
  | "comment_not_found"
  | "comment_not_by_chat_person"
  | "comment_not_voice"
  | "agent_not_listed"
  | "read_failed";

export type VoiceTurnDecision =
  | {
      voice: true;
      setting: Exclude<VoiceRunProfileSetting, "off">;
      chatIssueId: string;
      userId: string;
      commentIds: string[];
    }
  | { voice: false; reason: NormalRunReason };

export type VoiceTurnDeps = {
  /** The instance flag `enableVoiceRunProfile`. Defaults to a read-only settings read. */
  readVoiceFlag?: () => Promise<boolean>;
};

const normal = (reason: NormalRunReason): VoiceTurnDecision => ({ voice: false, reason });

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Rule 1, the retry and recovery part: no single field marks them, so each one is checked. */
function isRetryOrRecovery(run: VoiceTurnRun): boolean {
  return (
    present(run.retryOfRunId) ||
    text(run.scheduledRetryReason) !== null ||
    present(run.contextSnapshot?.executionRetryAccounting) ||
    present(run.resultJson?.systemRecoveryAdoption) ||
    present(run.contextSnapshot?.systemRecoveryAdoption)
  );
}

/** The `voice` marker of a stored comment, read as tolerantly as the comment read path. */
function isVoiceMetadata(metadata: unknown): boolean {
  const parsed = issueCommentMetadataSchema.safeParse(metadata);
  return parsed.success && parsed.data.voice?.mode === "direct";
}

export async function resolveVoiceTurn(
  db: Db,
  run: VoiceTurnRun,
  deps: VoiceTurnDeps = {},
): Promise<VoiceTurnDecision> {
  try {
    return await decide(db, run, deps);
  } catch {
    return normal("read_failed");
  }
}

async function decide(db: Db, run: VoiceTurnRun, deps: VoiceTurnDeps): Promise<VoiceTurnDecision> {
  const context = run.contextSnapshot ?? {};

  // Rule 1: an on-demand comment wake, not a retry or a recovery run.
  const chatIssueId = text(context.issueId);
  if (
    run.invocationSource !== "on_demand" ||
    text(context.wakeReason) !== "issue_commented" ||
    !chatIssueId ||
    (run.issueId != null && run.issueId !== chatIssueId)
  ) {
    return normal("not_comment_wake");
  }
  if (isRetryOrRecovery(run)) return normal("retry_or_recovery");

  // Rule 4, then rule 3 with the company half of rule 4: the reader answers "off" when the plugin is not
  // installed, not ready or disabled for the company, and for no row, no key or an invalid value.
  const readVoiceFlag =
    deps.readVoiceFlag ??
    (async () => (await instanceSettingsService(db).getExperimentalReadOnly(db)).enableVoiceRunProfile === true);
  if (!(await readVoiceFlag())) return normal("flag_off");
  const setting = await readVoiceRunProfileSetting(db, run.companyId);
  if (setting === "off") return normal("setting_off");

  // The run's chat: a conversation of this agent in this company.
  const [chat] = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      conversationAgentId: issues.conversationAgentId,
      conversationUserId: issues.conversationUserId,
    })
    .from(issues)
    .where(and(eq(issues.id, chatIssueId), eq(issues.companyId, run.companyId)));
  if (!chat || !isConversation(chat) || chat.conversationAgentId !== run.agentId) return normal("not_chat");
  const userId = chat.conversationUserId!;

  // Rule 2: every comment of the wake carries `voice` and was written by the chat's own person.
  const commentIds = extractWakeCommentIds(context);
  if (commentIds.length === 0) return normal("no_comments");
  const comments = await db
    .select({
      id: issueComments.id,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      authorType: issueComments.authorType,
      origin: issueComments.origin,
      metadata: issueComments.metadata,
      deletedAt: issueComments.deletedAt,
    })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, run.companyId),
      eq(issueComments.issueId, chat.id),
      inArray(issueComments.id, commentIds),
    ));
  if (comments.length !== commentIds.length || comments.some((comment) => comment.deletedAt)) {
    return normal("comment_not_found");
  }
  for (const comment of comments) {
    if (
      comment.authorAgentId ||
      comment.authorUserId !== userId ||
      (comment.authorType != null && comment.authorType !== "user") ||
      comment.origin !== "comment"
    ) {
      return normal("comment_not_by_chat_person");
    }
    if (!isVoiceMetadata(comment.metadata)) return normal("comment_not_voice");
  }

  // A restricted person keeps a voice turn only with an agent still on his list. A failed read throws
  // and so gives a normal run.
  const listed = await restrictedAgentIdsForActor(db, { type: "board", source: "session", userId }, run.companyId);
  if (listed && !listed.has(run.agentId)) return normal("agent_not_listed");

  return { voice: true, setting, chatIssueId: chat.id, userId, commentIds };
}
