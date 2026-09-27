/**
 * Announcement data (content.published once the change is live). The
 * hand-off service talks to this interface; the SQL version wraps db.ts and
 * the tests use an in-memory copy with the same rules (a sent key stays
 * sent; a stuck or dropped key waits again when it is queued again).
 */
import * as db from "../db.js";

export interface AnnouncementStore {
  queue(a: { key: string; companyId: string; sprintId: string; contentId: string | null; taskId: string | null; waitTaskId: string | null }): Promise<void>;
  get(companyId: string, key: string): Promise<db.Announcement | null>;
  due(companyId: string, limit?: number): Promise<db.Announcement[]>;
  waitingOn(companyId: string, taskId: string): Promise<db.Announcement[]>;
  recentlySent(companyId: string): Promise<db.Announcement[]>;
  open(companyId: string, sprintId?: string): Promise<db.Announcement[]>;
  update(companyId: string, key: string, patch: Record<string, unknown>): Promise<void>;
}

export function sqlAnnouncementStore(sql: db.SeoDb): AnnouncementStore {
  return {
    queue: (a) => db.queueAnnouncement(sql, a),
    get: (companyId, key) => db.getAnnouncement(sql, companyId, key),
    due: (companyId, limit) => db.dueAnnouncements(sql, companyId, limit),
    waitingOn: (companyId, taskId) => db.announcementsWaitingOn(sql, companyId, taskId),
    recentlySent: (companyId) => db.recentlySentAnnouncements(sql, companyId),
    open: (companyId, sprintId) => db.openAnnouncements(sql, companyId, sprintId),
    update: async (companyId, key, patch) => {
      await db.updateAnnouncement(sql, companyId, key, patch);
    },
  };
}
