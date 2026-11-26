/**
 * Turns an agent's chat reply (markdown) into text a voice can read, and splits it into chunks
 * for the speak action (plan PAR-14808, T3). Pure functions, no DOM.
 */
import { SPEECH_CHUNK_CHARS, SPEECH_FIRST_CHUNK_CHARS, SPEECH_MAX_CHARS } from "../limits.js";

export const CODE_IN_CHAT = "The code is in the chat.";
export const TABLE_IN_CHAT = "There's a table in the chat.";
export const LINK_IN_CHAT = "a link in the chat";
export const INLINE_CODE_IN_CHAT = "the code in the chat";
export const REST_IN_CHAT = "The rest is in the chat.";

const FENCE = /^\s*(```|~~~)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$|^\s*\|\s*:?-{2,}:?\s*\|?\s*$/;
const MENTION_SCHEMES = /^(agent|user|project|skill|routine):\/\//;
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu;

/** Code fences and tables become one fixed sentence each; other lines pass through. */
function blocksToSentences(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      if (!inFence) out.push(CODE_IN_CHAT);
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const next = lines[i + 1];
    const startsTable = line.includes("|") && next !== undefined && next.includes("|") && TABLE_SEPARATOR.test(next);
    if (startsTable || /^\s*\|.*\|\s*$/.test(line)) {
      if (startsTable) i += 1; // the separator row
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim() !== "") i += 1;
      out.push(TABLE_IN_CHAT);
      continue;
    }
    out.push(line);
  }
  return out;
}

function stripInline(line: string): string {
  let text = line;
  text = text.replace(/`+[^`\n]*`+/g, INLINE_CODE_IN_CHAT);
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g, (_all, label: string, href: string) =>
    MENTION_SCHEMES.test(href) ? label.replace(/^@/, "") : label);
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  text = text.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/g, url => {
    const trailing = /[.,;:!?)\]]+$/.exec(url)?.[0] ?? "";
    return LINK_IN_CHAT + trailing;
  });
  text = text.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  text = text.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
  text = text.replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s).,!?:;]|$)/g, "$1$2");
  text = text.replace(/(^|[\s(])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s).,!?:;]|$)/g, "$1$2");
  text = text.replace(EMOJI, "");
  return text.replace(/\s+/g, " ").trim();
}

/** Markdown reply → plain sentences, one space between them. Not capped; see `toSpeech`. */
export function stripMarkdown(markdown: string): string {
  const withoutFooter = markdown.replace(/^[ \t]*_Sent by voice[^\n]*_[ \t]*$/gm, "");
  const sentences: string[] = [];
  for (const raw of blocksToSentences(withoutFooter)) {
    if (/^\s*([-*_]\s*){3,}$/.test(raw)) continue; // horizontal rule
    let line = raw.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>+\s?/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    line = line.replace(/^\[[ xX]\]\s+/, "");
    line = stripInline(line);
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue;
    if (!/[.!?:;]$/.test(line)) line += ".";
    if (sentences[sentences.length - 1] === line && (line === CODE_IN_CHAT || line === TABLE_IN_CHAT)) continue;
    sentences.push(line);
  }
  return sentences.join(" ");
}

/** Cut at the last sentence end within `max`, else the last space; append the pointer to the chat. */
export function capSpeech(text: string, max = SPEECH_MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let cut = -1;
  for (const match of head.matchAll(/[.!?](?=\s|$)/g)) cut = match.index! + 1;
  if (cut <= 0) cut = head.lastIndexOf(" ");
  if (cut <= 0) cut = max;
  return `${head.slice(0, cut).trim()} ${REST_IN_CHAT}`;
}

/** What gets spoken for one agent reply comment. Empty string means nothing to say. */
export function toSpeech(markdown: string): string {
  return capSpeech(stripMarkdown(markdown));
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
}

/** Pack pieces into lines of at most `max`, joining with a space. A piece longer than `max` stays its own line. */
function pack(pieces: string[], max: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length <= max) current += ` ${piece}`;
    else {
      if (current) lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** One sentence longer than `max`: commas first, then spaces; a single word longer than `max` is cut. */
function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  for (const line of pack(sentence.split(/(?<=,)\s+/), max)) {
    if (line.length <= max) out.push(line);
    else {
      for (const part of pack(line.split(/\s+/), max)) {
        if (part.length <= max) out.push(part);
        else for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
      }
    }
  }
  return out;
}

/**
 * Split speakable text into chunks for `speak`: the first at most `first` characters (fast first
 * audio), later ones at most `max`. Breaks on sentence ends, then commas, then spaces.
 */
export function chunk(text: string, max = SPEECH_CHUNK_CHARS, first = SPEECH_FIRST_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  const limit = () => (chunks.length === 0 ? first : max);
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const sentence of splitSentences(text.replace(/\s+/g, " ").trim())) {
    if (current && current.length + 1 + sentence.length <= limit()) {
      current += ` ${sentence}`;
      continue;
    }
    flush();
    if (sentence.length <= limit()) {
      current = sentence;
      continue;
    }
    // Too long for the slot it would take: split it, each part sized for its own slot.
    let rest = sentence;
    while (rest.length > limit()) {
      const head = splitLong(rest, limit())[0]!;
      chunks.push(head);
      rest = rest.slice(head.length).trim();
    }
    current = rest;
  }
  flush();
  return chunks;
}
