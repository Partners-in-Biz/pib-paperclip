/**
 * Runs the site events script (`static-src/ev.js`, minified the way the build does) and its frame (`static/ev-frame.js`) in a small
 * browser stand-in: enough of a page to see what each would send, to whom, and what each would keep on the visitor's device.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";
import * as esbuild from "esbuild";

/** The script as the build writes it (the header is the build's own). */
export function builtEventsScript(): string {
  const config = readFileSync(new URL("../../esbuild.config.mjs", import.meta.url), "utf8");
  const header = /const evHeader = "([^"]+)";/.exec(config)?.[1];
  if (!header) throw new Error("the build's events header was not found");
  const source = readFileSync(new URL("../../static-src/ev.js", import.meta.url), "utf8");
  return `${header}${esbuild.transformSync(source, { minify: true, legalComments: "none", target: "es2019" }).code}`;
}

class Store {
  data = new Map<string, string>();
  getItem = (name: string) => this.data.get(name) ?? null;
  setItem = (name: string, value: string) => void this.data.set(name, String(value));
  removeItem = (name: string) => void this.data.delete(name);
}

export interface Clickable {
  closest: (selector: string) => { getAttribute: (name: string) => string | null } | null;
}

export interface EvWorld {
  frames: Array<{ src: string; hidden: boolean; messages: Array<{ message: Record<string, any>; target: string }>; load: () => void }>;
  listeners: Record<string, Array<(event: any) => void>>;
  session: Store;
  local: Store;
  window: Record<string, any>;
  /** Everything the page script has handed the frame so far, flattened. */
  events: () => Array<Record<string, any>>;
  click: (href: string) => void;
  submit: () => void;
  domReady: () => void;
}

export interface EvOptions {
  attrs?: Record<string, string>;
  /** Where the visit is: path and query. */
  url?: string;
  referrer?: string;
  dnt?: string | null;
  gpc?: boolean;
  session?: Store;
  local?: Store;
  /** The page has no body yet (a script in the head that ran early). */
  noBody?: boolean;
  script?: string;
}

export function loadEvents(options: EvOptions = {}): EvWorld {
  const url = new URL(options.url ?? "https://acme.co.za/services/seo?utm_source=google&utm_medium=cpc");
  const attrs: Record<string, string> = { "data-pib-ev": "pibe_abcdefghijklmnopqrstuvwx", ...(options.attrs ?? {}) };
  const frames: EvWorld["frames"] = [];
  const listeners: EvWorld["listeners"] = {};
  const session = options.session ?? new Store();
  const local = options.local ?? new Store();
  const body = { appendChild: vi.fn() };
  const document: Record<string, any> = {
    currentScript: { src: "https://paperclip.partnersinbiz.online/_plugins/11111111-2222-3333-4444-555555555555/ui/ev.js", getAttribute: (name: string) => attrs[name] ?? null },
    referrer: options.referrer ?? "",
    body: options.noBody ? null : body,
    addEventListener: (type: string, fn: (event: any) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    createElement: (tag: string) => {
      if (tag !== "iframe") throw new Error(`unexpected element ${tag}`);
      const frame = {
        src: "",
        hidden: false,
        onload: null as null | (() => void),
        messages: [] as Array<{ message: Record<string, any>; target: string }>,
        contentWindow: { postMessage: (message: Record<string, any>, target: string) => frame.messages.push({ message: JSON.parse(JSON.stringify(message)), target }) },
        load: () => frame.onload?.(),
      };
      frames.push(frame);
      return frame;
    },
  };
  const window: Record<string, any> = {};
  const sandbox = {
    window,
    document,
    navigator: { doNotTrack: options.dnt ?? null, globalPrivacyControl: options.gpc ?? false },
    location: { hostname: url.hostname, pathname: url.pathname, search: url.search, href: url.href, origin: url.origin, toString: () => url.href },
    localStorage: local,
    sessionStorage: session,
    URL,
    URLSearchParams,
    JSON,
    String,
    RegExp,
  };
  // The script reads `window`, `document`, `navigator` and `location` as the arguments of its wrapper and the storages as globals.
  runInNewContext(options.script ?? builtEventsScript(), sandbox);
  const world: EvWorld = {
    frames,
    listeners,
    session,
    local,
    window,
    events: () => frames.flatMap((frame) => frame.messages.flatMap((entry) => entry.message.ev as Array<Record<string, any>>)),
    click: (href) => {
      const link = { getAttribute: (name: string) => (name === "href" ? href : null) };
      for (const fn of listeners.click ?? []) fn({ target: { closest: (selector: string) => (selector === "a[href]" ? link : null) } });
    },
    submit: () => {
      for (const fn of listeners.submit ?? []) fn({});
    },
    domReady: () => {
      document.body = body;
      for (const fn of listeners.DOMContentLoaded ?? []) fn({});
    },
  };
  // The hidden frame loads: the script then hands it what it has queued.
  frames[0]?.load();
  return world;
}

export interface FrameWorld {
  fetch: ReturnType<typeof vi.fn>;
  /** A message from `source` (the embedding page when it is the window's parent). */
  message: (data: unknown, origin?: string, fromParent?: boolean) => void;
}

/** Runs `static/ev-frame.js` as the page inside the hidden iframe, at the given fragment. */
export function loadFrame(hash: string): FrameWorld {
  const listeners: Array<(event: any) => void> = [];
  const parent = {};
  const fetchMock = vi.fn(async () => ({ ok: true }));
  const window: Record<string, any> = {
    location: { hash },
    parent,
    addEventListener: (type: string, fn: (event: any) => void) => {
      if (type === "message") listeners.push(fn);
    },
  };
  runInNewContext(readFileSync(new URL("../../static/ev-frame.js", import.meta.url), "utf8"), { window, fetch: fetchMock, JSON, Array, String, Promise });
  return { fetch: fetchMock, message: (data, origin = "https://acme.co.za", fromParent = true) => listeners.forEach((fn) => fn({ source: fromParent ? parent : {}, origin, data })) };
}
