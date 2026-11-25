export const PERSONAL_NOTE_COLORS = [
  "default",
  "amber",
  "blue",
  "emerald",
  "rose",
  "violet",
] as const;

export type PersonalNoteColor = (typeof PERSONAL_NOTE_COLORS)[number];

export const PERSONAL_NOTE_SCHEDULE_STATUSES = [
  "none",
  "pending",
  "dispatched",
  "failed",
  "cancelled",
] as const;

export type PersonalNoteScheduleStatus =
  (typeof PERSONAL_NOTE_SCHEDULE_STATUSES)[number];

export const PERSONAL_NOTE_RECURRENCES = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
] as const;

export type PersonalNoteRecurrence = (typeof PERSONAL_NOTE_RECURRENCES)[number];

export interface PersonalNoteLinkedTask {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  issuePriority: string | null;
  assigneeAgentId: string | null;
  sourceLine: string | null;
  createdAt: string;
}

export interface PersonalNote {
  id: string;
  companyId: string;
  userId: string;
  title: string;
  body: string;
  tags: string[];
  color: PersonalNoteColor;
  pinned: boolean;
  archived: boolean;
  projectId: string | null;
  dailyDate: string | null;
  scheduledFor: string | null;
  scheduledAgentId: string | null;
  scheduledProjectId: string | null;
  scheduledPriority: string;
  scheduledIssueStatus: string;
  scheduledInstructions: string | null;
  scheduledRecurrence: PersonalNoteRecurrence;
  scheduledStatus: PersonalNoteScheduleStatus;
  scheduledError: string | null;
  handedOffIssueId: string | null;
  handedOffIssueIdentifier: string | null;
  handedOffIssueTitle: string | null;
  handedOffAt: string | null;
  linkedTasks: PersonalNoteLinkedTask[];
  createdAt: string;
  updatedAt: string;
}
