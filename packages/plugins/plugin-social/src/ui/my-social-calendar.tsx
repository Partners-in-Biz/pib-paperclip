import { useState } from "react";
import { tokens, tone } from "@partnersinbiz/pib-plugin-ui";
import { fmtDate, Muted, Row, SmallButton } from "./parts.js";
import type { Post, Snapshot } from "./types.js";

export function CalendarTab({ posts, snapshot }: { posts: Post[]; snapshot: Snapshot }) {
  const [offset, setOffset] = useState(0);
  const tz = snapshot.config.timezone;

  const dayKey = (value: string) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
    } catch {
      return value.slice(0, 10);
    }
  };

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + 1 + offset * 14);
  const days = Array.from({ length: 14 }, (_, i) => new Date(start.getTime() + i * 86_400_000));
  const todayKey = dayKey(new Date().toISOString());

  const byDay = new Map<string, Post[]>();
  for (const post of posts) {
    const when = post.status === "published" ? post.publishedAt : post.scheduledAt;
    if (!when) continue;
    const key = dayKey(when);
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Row style={{ justifyContent: "space-between" }}>
        <SmallButton onClick={() => setOffset((o) => o - 1)}>← Earlier</SmallButton>
        <Muted>
          {fmtDate(days[0]!.toISOString(), tz, false)} – {fmtDate(days[13]!.toISOString(), tz, false)} ({tz})
        </Muted>
        <SmallButton onClick={() => setOffset((o) => o + 1)}>Later →</SmallButton>
      </Row>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {days.map((day) => {
          const key = dayKey(day.toISOString());
          const list = (byDay.get(key) ?? []).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
          return (
            <div
              key={key}
              style={{
                display: "grid",
                gap: 6,
                alignContent: "start",
                minHeight: 100,
                padding: 10,
                borderRadius: 10,
                border: `1px solid ${key === todayKey ? tone("accent").border : tokens.border}`,
                background: key === todayKey ? `linear-gradient(180deg, ${tone("accent").soft}, transparent 60%), ${tokens.card}` : tokens.card,
              }}
            >
              <Muted style={{ fontWeight: 600, fontSize: 12, color: key === todayKey ? tone("accent").fg : undefined }}>
                {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
              </Muted>
              {list.length ? (
                <div style={{ fontSize: 10, color: tokens.muted }}>
                  {list.length} post{list.length !== 1 ? "s" : ""}
                </div>
              ) : null}
              {list.map((post) => (
                <div
                  key={post.id}
                  style={{
                    fontSize: 11,
                    padding: "4px 6px",
                    borderRadius: 6,
                    background: tone(post.status === "published" ? "ok" : "info").soft,
                    color: tokens.fg,
                    lineHeight: 1.3,
                    overflowWrap: "break-word",
                  }}
                >
                  {post.body.slice(0, 40)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
