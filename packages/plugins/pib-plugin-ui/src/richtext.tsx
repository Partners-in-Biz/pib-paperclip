/**
 * Inline markdown for short texts that plugins write for people (setup steps,
 * issue-style details): **bold**, `code` and [label](link). Anything else is
 * shown as plain text; nothing is parsed as HTML, so it is safe for any string.
 */
import { Fragment, type ReactNode } from "react";
import { tokens } from "./tokens.js";

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Only Paperclip paths and http(s) links become anchors. */
function safeHref(href: string): string | null {
  return href.startsWith("/") || /^https?:\/\//i.test(href) ? href : null;
}

export function inlineParts(text: string): Array<{ kind: "text" | "bold" | "code" | "link"; value: string; href?: string }> {
  const parts: Array<{ kind: "text" | "bold" | "code" | "link"; value: string; href?: string }> = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", value: text.slice(last, at) });
    const token = match[0];
    if (token.startsWith("**")) parts.push({ kind: "bold", value: token.slice(2, -2) });
    else if (token.startsWith("`")) parts.push({ kind: "code", value: token.slice(1, -1) });
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]!) : null;
      parts.push(href ? { kind: "link", value: link![1]!, href } : { kind: "text", value: token });
    }
    last = at + token.length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

/**
 * `<InlineText text="Click **Create service account** and copy `SEO_KEY`." />`.
 * Pass `linkFor` (the host's `linkProps`) so Paperclip paths navigate in-app.
 */
export function InlineText({ text, linkFor }: { text: string; linkFor?: (href: string) => Record<string, unknown> }): ReactNode {
  return (
    <>
      {inlineParts(text).map((part, index) => {
        if (part.kind === "bold") return <strong key={index} style={{ fontWeight: 650, color: tokens.fg }}>{part.value}</strong>;
        if (part.kind === "code") return <code key={index} style={{ fontSize: "0.92em", padding: "1px 5px", borderRadius: 5, background: tokens.secondary, color: tokens.fg, overflowWrap: "anywhere" }}>{part.value}</code>;
        if (part.kind === "link" && part.href) {
          const props = part.href.startsWith("/") && linkFor ? linkFor(part.href) : { href: part.href, target: "_blank", rel: "noreferrer" };
          return <a key={index} {...props} style={{ color: tokens.primary }}>{part.value}</a>;
        }
        return <Fragment key={index}>{part.value}</Fragment>;
      })}
    </>
  );
}
