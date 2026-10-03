/**
 * A very small DOM, just enough to run static/lead-form.js the way a browser
 * would: build the form, take a submit, call fetch, show messages. It exists
 * so the page script is tested end to end without adding a DOM library.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";

export class MiniNode {
  attrs: Record<string, string> = {};
  children: MiniNode[] = [];
  listeners: Record<string, (event: unknown) => void> = {};
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  onload: (() => void) | null = null;
  async = false;
  src = "";

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: unknown): void {
    this.attrs[name] = String(value);
    if (name === "value") this.value = String(value);
  }

  appendChild<T extends MiniNode>(child: T): T {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners[type] = fn;
  }

  get id(): string | undefined {
    return this.attrs.id;
  }

  /** Depth-first search for an element by id, or by any predicate. */
  find(test: (node: MiniNode) => boolean): MiniNode | null {
    if (test(this)) return this;
    for (const child of this.children) {
      const hit = child.find(test);
      if (hit) return hit;
    }
    return null;
  }

  findAll(test: (node: MiniNode) => boolean, out: MiniNode[] = []): MiniNode[] {
    if (test(this)) out.push(this);
    for (const child of this.children) child.findAll(test, out);
    return out;
  }
}

export interface PageWorld {
  form: MiniNode;
  done: MiniNode;
  head: MiniNode;
  posted: Array<Record<string, unknown>>;
  fetch: ReturnType<typeof vi.fn>;
  styles: Record<string, string>;
  window: { turnstile?: { render: (selector: string, options: Record<string, (token?: string) => void> & { sitekey: string }) => void } };
  byId: (id: string) => MiniNode;
  byName: (name: string) => MiniNode;
  /** Types into a field by its name. */
  type: (name: string, value: string) => void;
  /** Ticks or unticks the consent box. */
  tick: (on: boolean) => void;
  submit: () => void;
}

/**
 * Runs `static/lead-form.js` against a page with `#f` and `#done`, at the given address fragment.
 * `respond` answers the form's one request (default: an ok answer).
 */
export function loadFormPage(hash: string, respond: (url: string, init: { method: string; body: string }) => { ok: boolean; body: unknown } | Promise<never> = () => ({ ok: true, body: { deliveryId: "d1", status: "success" } })): PageWorld {
  const form = new MiniNode("form");
  form.setAttribute("id", "f");
  const done = new MiniNode("div");
  done.setAttribute("id", "done");
  done.hidden = true;
  const head = new MiniNode("head");
  const body = new MiniNode("body");
  const posted: Array<Record<string, unknown>> = [];
  const styles: Record<string, string> = {};
  const all = [form, done];

  const fetchMock = vi.fn(async (url: string, init: { method: string; body: string }) => {
    const answer = await respond(url, init);
    return { ok: answer.ok, json: async () => answer.body };
  });

  class FakeFormData {
    private pairs: Array<[string, string]> = [];
    constructor(root: MiniNode) {
      for (const node of root.findAll((n) => Boolean(n.attrs.name))) {
        if (node.attrs.type === "checkbox") {
          if (node.checked) this.pairs.push([node.attrs.name!, "on"]);
        } else {
          this.pairs.push([node.attrs.name!, node.value]);
        }
      }
    }
    forEach(fn: (value: string, name: string) => void): void {
      for (const [name, value] of this.pairs) fn(value, name);
    }
  }

  const window: PageWorld["window"] & { location: { hash: string }; parent: { postMessage: (message: Record<string, unknown>) => void } } = {
    location: { hash },
    parent: { postMessage: (message) => { posted.push(message); } },
  };
  const document = {
    head,
    body,
    documentElement: { scrollHeight: 321, style: { setProperty: (name: string, value: string) => { styles[name] = value; } } },
    getElementById: (id: string) => form.find((node) => node.id === id) ?? done.find((node) => node.id === id),
    createElement: (tag: string) => {
      const node = new MiniNode(tag);
      all.push(node);
      return node;
    },
  };

  runInNewContext(readFileSync(new URL("../../static/lead-form.js", import.meta.url), "utf8"), {
    window,
    document,
    fetch: fetchMock,
    FormData: FakeFormData,
    Date,
    Object,
    JSON,
    Math,
    String,
    Array,
    Promise,
    decodeURIComponent,
    encodeURIComponent,
  });

  const byName = (name: string) => form.find((node) => node.attrs.name === name)!;
  return {
    form,
    done,
    head,
    posted,
    fetch: fetchMock,
    styles,
    window,
    byId: (id) => form.find((node) => node.id === id) ?? done.find((node) => node.id === id)!,
    byName,
    type: (name, value) => { byName(name).value = value; },
    tick: (on) => { byName("consent").checked = on; },
    submit: () => form.listeners.submit!({ preventDefault: () => undefined }),
  };
}

/** Lets the form's promise chain (fetch, json, then) run to the end. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
