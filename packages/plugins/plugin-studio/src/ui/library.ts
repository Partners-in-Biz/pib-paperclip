/** Pure helpers for the library cards (PAR-8047): titles, meta lines, ages and status tones. */

const TITLE_WORDS = 6;

/** A human title: the first six words of the prompt, cut at a word, never mid-word. Falls back to the asset name. */
export function humanTitle(prompt: string | null | undefined, name: string): string {
  const source = (prompt ?? "").trim() || name.trim();
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled";
  const cut = words.slice(0, TITLE_WORDS).join(" ").replace(/[\s,;:.!?-]+$/, "");
  const title = cut.charAt(0).toUpperCase() + cut.slice(1);
  return words.length > TITLE_WORDS ? `${title}…` : title;
}

/** "2 h ago", "Yesterday", "3 d ago", or a date for older items. */
export function relativeAge(at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return "";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} d ago`;
  return at.slice(0, 10);
}

export function kindLabel(kind: string): string {
  return kind === "video" ? "Video" : kind === "image" ? "Image" : kind === "audio" ? "Audio" : kind;
}

/** One meta line: kind, model, cost, age. `short` (phone) keeps kind and age only. */
export function metaLine(a: { kind: string; model?: string | null; credits?: number | null; createdAt: string | null }, modelLabel: (id: string) => string, short = false, now?: number): string {
  const parts = [kindLabel(a.kind)];
  if (!short && a.model) parts.push(modelLabel(a.model));
  if (!short && typeof a.credits === "number") parts.push(`${Number(a.credits.toFixed(2))} cr`);
  const age = relativeAge(a.createdAt, now);
  if (age) parts.push(age);
  return parts.join(" · ");
}

/** Status pill tone: Draft amber, Approved green, Rejected red, anything else neutral. */
export function statusTone(status: string): "warn" | "ok" | "bad" | "neutral" {
  if (status === "draft") return "warn";
  if (status === "approved") return "ok";
  if (status === "rejected") return "bad";
  return "neutral";
}

export function statusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "";
}

/** 5.2 → "0:05". */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A video URL that makes the browser paint the first frame as the poster (no autoplay, no download of the whole file). */
export function posterFrameUrl(url: string): string {
  return url.includes("#") ? url : `${url}#t=0.1`;
}
