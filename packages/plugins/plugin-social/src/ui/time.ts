/**
 * Date helpers for the Social page (pure, no React, so tests can import them).
 */

export function fmtDate(value: string | null | undefined, timeZone?: string, withTime = true): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString(undefined, {
      timeZone,
      day: "numeric",
      month: "short",
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    });
  } catch {
    return date.toLocaleString();
  }
}

/** A Date as the value of an `<input type="datetime-local">` (the viewer's local time). */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "Published …", "Scheduled …", "Proposed …" (a draft's time, kept on approval) or "Updated …". Pure. */
export function timeLabel(post: { status: string; scheduledAt: string | null; publishedAt: string | null; updatedAt: string | null }, timeZone?: string): string {
  if (post.status === "published" || post.status === "partially_published") return `Published ${fmtDate(post.publishedAt, timeZone)}`;
  if (post.scheduledAt) {
    const word = post.status === "scheduled" || post.status === "publishing" || post.status === "failed" ? "Scheduled" : "Proposed";
    return `${word} ${fmtDate(post.scheduledAt, timeZone)}`;
  }
  return post.status === "approved" ? "Approved, no time yet" : `Updated ${fmtDate(post.updatedAt, timeZone)}`;
}

