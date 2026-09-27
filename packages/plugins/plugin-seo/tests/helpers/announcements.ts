/**
 * In-memory announcement store with the SQL store's rules (tests only): a
 * sent key stays sent; a stuck or dropped key waits again when re-queued.
 */
import type { Announcement } from "../../src/db.js";
import type { AnnouncementStore } from "../../src/service/announcement-store.js";

const COLUMN: Record<string, keyof Announcement> = {
  wait_task_id: "waitTaskId",
  url: "url",
  status: "status",
  checks: "checks",
  last_http_status: "lastHttpStatus",
  last_error: "lastError",
  payload: "payload",
  next_check_at: "nextCheckAt",
  sent_at: "sentAt",
};

export function memoryAnnouncements(now: () => Date): AnnouncementStore & { rows: Map<string, Announcement> } {
  const rows = new Map<string, Announcement>();
  const at = () => now().getTime();
  return {
    rows,
    async queue(a) {
      const current = rows.get(a.key);
      const stamp = now().toISOString();
      if (!current) {
        rows.set(a.key, { ...a, url: null, status: "waiting", checks: 0, lastHttpStatus: null, lastError: null, payload: null, queuedAt: stamp, nextCheckAt: stamp, sentAt: null });
        return;
      }
      const reopen = current.status === "stuck" || current.status === "dropped";
      rows.set(a.key, {
        ...current,
        contentId: a.contentId ?? current.contentId,
        taskId: a.taskId ?? current.taskId,
        waitTaskId: a.waitTaskId ?? current.waitTaskId,
        status: reopen ? "waiting" : current.status,
        checks: reopen ? 0 : current.checks,
        queuedAt: reopen ? stamp : current.queuedAt,
        nextCheckAt: current.status === "sent" ? current.nextCheckAt : stamp,
      });
    },
    async get(companyId, key) {
      const row = rows.get(key);
      return row && row.companyId === companyId ? { ...row } : null;
    },
    async due(companyId) {
      return [...rows.values()].filter((r) => r.companyId === companyId && (r.status === "waiting" || r.status === "stuck") && Date.parse(r.nextCheckAt ?? "") <= at()).map((r) => ({ ...r }));
    },
    async waitingOn(companyId, taskId) {
      return [...rows.values()].filter((r) => r.companyId === companyId && r.waitTaskId === taskId && (r.status === "waiting" || r.status === "stuck")).map((r) => ({ ...r }));
    },
    async recentlySent(companyId) {
      return [...rows.values()].filter((r) => r.companyId === companyId && r.status === "sent" && at() - Date.parse(r.sentAt ?? "") <= 24 * 3600_000).map((r) => ({ ...r }));
    },
    async open(companyId, sprintId) {
      return [...rows.values()].filter((r) => r.companyId === companyId && (r.status === "waiting" || r.status === "stuck") && (!sprintId || r.sprintId === sprintId)).map((r) => ({ ...r }));
    },
    async update(companyId, key, patch) {
      const row = rows.get(key);
      if (!row || row.companyId !== companyId) return;
      const next = { ...row } as Record<string, unknown>;
      for (const [column, value] of Object.entries(patch)) {
        const field = COLUMN[column];
        if (field) next[field] = value;
      }
      rows.set(key, next as unknown as Announcement);
    },
  };
}
