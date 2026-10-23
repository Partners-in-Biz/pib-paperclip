import { Pill, tokens } from "@partnersinbiz/pib-plugin-ui";
import { Muted, Row } from "./parts.js";
import type { Post } from "./types.js";

/** "Replying to @handle" / "Quoting @handle" with the target link, plus the internal note. Nothing when the post has none. */
export function PostTarget({ post, compact = false }: { post: Pick<Post, "replyTo" | "quote" | "note">; compact?: boolean }) {
  const target = post.replyTo ?? post.quote;
  if (!target && !post.note) return null;
  const who = target?.handle ? `@${target.handle}` : "an X post";
  return (
    <Row style={{ flexWrap: "wrap", minWidth: 0 }}>
      {target ? (
        <>
          <Pill size="sm" variant="soft" tone="info">{post.replyTo ? "Replying to" : "Quoting"} {who}</Pill>
          {compact ? null : <a href={target.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: tokens.primary, overflowWrap: "anywhere" }}>{target.url}</a>}
        </>
      ) : null}
      {post.note ? <Pill size="sm" variant="outline" tone="warn" title={post.note}>{post.note.length > (compact ? 40 : 80) ? `${post.note.slice(0, compact ? 40 : 80)}…` : post.note}</Pill> : null}
      {compact && target ? <Muted>X</Muted> : null}
    </Row>
  );
}
