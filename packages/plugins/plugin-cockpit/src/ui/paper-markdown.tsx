/**
 * The small markdown the Daily Paper's writers use, as blocks: paragraphs,
 * `-` / `*` and `1.` lists, `###` sub-heads and `>` quotes; inside a line
 * **bold**, *italic*, `code` and [links](...). Nothing is parsed as HTML, so
 * any string is safe to show.
 */
import { Fragment, type AnchorHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { inlineParts } from "@partnersinbiz/pib-plugin-ui";

export type PaperBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEAD = /^\s*#{1,6}\s+(.*)$/;
/** A line that is only bold text is a sub-head too (writers use both). */
const BOLD_LINE = /^\s*\*\*([^*]+)\*\*:?\s*$/;

export function paperBlocks(markdown: string): PaperBlock[] {
  const out: PaperBlock[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
    if (list) out.push(list);
    list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const head = HEAD.exec(line) ?? BOLD_LINE.exec(line);
    if (head) {
      flush();
      out.push({ kind: "h", text: head[1]!.trim() });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);
    if (bullet || number) {
      const kind = bullet ? "ul" : "ol";
      if (para.length || (list && list.kind !== kind)) flush();
      list ??= { kind, items: [] };
      list.items.push((bullet ?? number)![1]!.trim());
      continue;
    }
    if (line.startsWith(">")) {
      flush();
      out.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
      continue;
    }
    // An indented line under a list item continues that item.
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return out;
}

export type PaperLinkFor = (href: string) => AnchorHTMLAttributes<HTMLAnchorElement>;

/** Paperclip paths and addresses on this site open in the app; anything else opens in a new tab. */
export function isInternal(href: string, origin: string | null): boolean {
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  if (!origin) return false;
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

/** `*word*` or `_word_` standing on its own. A mark inside a word is not one: `FIREBASE_SA_WEBTOOLS` and `2*3*4` stay as written. */
const ITALIC = /((?<![\p{L}\p{N}*])\*[^*\s](?:[^*]*[^*\s])?\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_[^_\s](?:[^_]*[^_\s])?_(?![\p{L}\p{N}_]))/gu;

export function italicParts(text: string): string[] {
  return text.split(ITALIC);
}

function withItalics(text: string, key: string): ReactNode {
  const parts = text.split(ITALIC);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 === 1 ? <em key={`${key}-${i}`}>{part.slice(1, -1)}</em> : <Fragment key={`${key}-${i}`}>{part}</Fragment>));
}

export function PaperInline({ text, linkFor, linkStyle }: { text: string; linkFor: PaperLinkFor; linkStyle?: CSSProperties }): ReactNode {
  const origin = typeof window !== "undefined" ? window.location.origin : null;
  return (
    <>
      {inlineParts(text).map((part, index) => {
        if (part.kind === "bold") return <strong key={index} style={{ fontWeight: 700 }}>{part.value}</strong>;
        if (part.kind === "code") return <code key={index} style={{ fontSize: "0.9em", overflowWrap: "anywhere" }}>{part.value}</code>;
        if (part.kind === "link" && part.href) {
          const props = isInternal(part.href, origin) ? linkFor(part.href) : { href: part.href, target: "_blank", rel: "noreferrer" };
          return <a key={index} {...props} style={linkStyle}>{part.value}</a>;
        }
        return <Fragment key={index}>{withItalics(part.value, String(index))}</Fragment>;
      })}
    </>
  );
}

/** A big first letter needs a paragraph of a few lines beside it; on a one-line opener it only pushes the next block aside. */
export const DROP_CAP_MIN_CHARS = 200;

export function PaperBody({ markdown, linkFor, dropCap = false, className }: { markdown: string; linkFor: PaperLinkFor; dropCap?: boolean; className?: string }) {
  const blocks = paperBlocks(markdown);
  const link: CSSProperties = { color: "inherit", textDecoration: "underline", textDecorationColor: "var(--paper-accent)", textDecorationThickness: 1, textUnderlineOffset: 3 };
  return (
    <div className={className}>
      {blocks.map((block, index) => {
        if (block.kind === "h") return <h4 key={index} className="pib-paper-sub"><PaperInline text={block.text} linkFor={linkFor} linkStyle={link} /></h4>;
        if (block.kind === "quote") return <blockquote key={index} className="pib-paper-quote"><PaperInline text={block.text} linkFor={linkFor} linkStyle={link} /></blockquote>;
        if (block.kind === "ul" || block.kind === "ol") {
          const List = block.kind;
          return (
            <List key={index} className="pib-paper-list">
              {block.items.map((item, i) => <li key={i}><PaperInline text={item} linkFor={linkFor} linkStyle={link} /></li>)}
            </List>
          );
        }
        if (block.kind !== "p") return null;
        return <p key={index} className={dropCap && index === 0 && block.text.length >= DROP_CAP_MIN_CHARS ? "pib-paper-p pib-paper-drop" : "pib-paper-p"}><PaperInline text={block.text} linkFor={linkFor} linkStyle={link} /></p>;
      })}
    </div>
  );
}
