// @vitest-environment jsdom
/**
 * The panel resolves the call context once (PAR-14996 T2): Start waits at most 3 s for it, a mode switch does not read it
 * again, and the header line and the save target do not follow the route if it changes during the call.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>>, stopped: 0 }));

vi.mock("../src/ui/actions.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ui/actions.js")>();
  const answers: Record<string, unknown> = { "get-my-voice-mode": { mode: "direct", provider: "grok", geminiConfigured: false }, "set-my-voice-mode": {} };
  const cache = new Map<string, (p?: unknown) => Promise<unknown>>();
  const useVoiceAction = (key: string) => {
    if (!cache.has(key)) cache.set(key, async () => answers[key] ?? {});
    return cache.get(key)!;
  };
  return { ...real, useVoiceAction };
});
vi.mock("../src/ui/direct-session.js", () => ({
  DirectSession: class {
    constructor(opts: Record<string, unknown>) {
      h.started.push(opts);
    }
    async start() {}
    stop() {
      h.stopped += 1;
    }
    interrupt() {}
  },
}));
vi.mock("../src/ui/live-session.js", () => ({
  LiveSession: class {
    constructor(opts: Record<string, unknown>) {
      h.started.push(opts);
    }
    async start() {}
    stop() {
      h.stopped += 1;
    }
  },
}));
vi.mock("@paperclipai/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk/ui")>()),
  usePluginData: () => ({ data: null, loading: true, error: null, refresh: () => {} }),
}));

const { LivePanel } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const fetched: string[] = [];
let issueAnswer: "ok" | "never" = "ok";

const AGENTS = [
  { id: "a-ceo", name: "PiB", role: "ceo", status: "idle" },
  { id: "a-dev", name: "Sam", role: "engineer", status: "idle" },
];
const ISSUE = { id: "i9", identifier: "PAR-9", title: "Fix login", status: "todo", description: "d", assigneeAgentId: "a-dev", visibility: "open", privacyParentIssueId: null, projectId: null, project: null };
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  Element.prototype.scrollTo = () => {};
  h.started.length = 0;
  h.stopped = 0;
  fetched.length = 0;
  issueAnswer = "ok";
  window.history.pushState({}, "", "/PAR/issues/PAR-9");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = String(url).replace(/^\/api/, "");
      fetched.push(path);
      if (path === `/companies/${COMPANY}/agents`) return Promise.resolve(json(AGENTS));
      if (path.startsWith("/issues/i9/comments")) return Promise.resolve(json([]));
      if (path === "/issues/chat-7") return Promise.resolve(json({ id: "c7", identifier: "PAR-7" }));
      if (path === "/issues/PAR-9") return issueAnswer === "never" ? new Promise(() => {}) : Promise.resolve(json(ISSUE));
      return Promise.resolve(json({}));
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctxOf = (i: number) => h.started[i]!.context as { kind: string; issueRef?: string; saveRef?: string; agentId: string | null };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
const audioContext = { state: "running", close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) } as unknown as AudioContext;
const mount = () =>
  act(() => root.render(<LivePanel companyId={COMPANY} userId="u1" audioContext={audioContext} wakeLock={null} wakeNotice={null} onClose={() => {}} onSwitch={() => {}} />));

describe("LivePanel call context", () => {
  it("a chat-page call saves to the chat issue the session resolved, and shows the wait for chunk 0 (PAR-15051)", async () => {
    window.history.pushState({}, "", "/PAR/chats/pib");
    await mount();
    await flush();
    expect(ctxOf(0).kind).toBe("chat");
    const opts = h.started[0]! as Record<string, (...args: unknown[]) => unknown>;
    const call = { entries: [{ who: "you", text: "Hi", at: Date.now() }], startedAt: Date.now(), endedAt: Date.now() };
    await act(async () => {
      opts.onTarget!({ issueId: "chat-7", ref: "PAR-7", agentName: "PiB", agentId: "a-ceo" });
      await opts.onAutosave!(call);
    });
    expect(fetched).toContain("/issues/chat-7");
    expect(fetched.some((p) => p.startsWith("/issues/c7/documents/live-chat-transcript-"))).toBe(true);
    expect(fetched).not.toContain("/issues/c7/comments");
    await act(async () => {
      opts.onEnd!(call, []);
    });
    await flush();
    expect(fetched).toContain("/issues/c7/comments");

    await act(async () => {
      opts.onState!("speaking");
      opts.onVoicing!(Date.now() - 3_200);
    });
    expect(document.body.textContent).toContain("Voicing the reply… 3 s");
    await act(async () => {
      opts.onVoicing!(null);
    });
    expect(document.body.textContent).not.toContain("Voicing the reply");
  });

  it("reads the task once, talks to its assignee, and keeps the header and save target when the route changes", async () => {
    await mount();
    await flush();
    expect(h.started).toHaveLength(1);
    expect(ctxOf(0)).toMatchObject({ kind: "task", issueRef: "PAR-9", saveRef: "PAR-9", agentId: "a-dev" });
    expect(document.body.textContent).toContain("Talking with Sam");
    expect(document.body.textContent).toContain("About PAR-9");

    // The person navigates to a chat page mid-call, then switches mode.
    window.history.pushState({}, "", "/PAR/chats/pib");
    const select = document.querySelector<HTMLSelectElement>("[data-pib-voice=mode]")!;
    await act(async () => {
      select.value = "classic";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(h.stopped).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent).toContain("About PAR-9");
    expect(fetched.filter((p) => p === "/issues/PAR-9")).toHaveLength(1);
    expect(fetched.filter((p) => p.startsWith("/issues/i9/comments"))).toHaveLength(1);
  });

  it("an unanswered task read lets the call start at 3 s with the default agent and the identifier only", async () => {
    vi.useFakeTimers();
    issueAnswer = "never";
    await mount();
    await flush();
    expect(h.started).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await flush();
    expect(h.started).toHaveLength(1);
    expect(ctxOf(0)).toMatchObject({ kind: "task", agentId: "a-ceo", saveRef: "PAR-9" });
    expect((h.started[0]!.context as { block: unknown }).block).toBeNull();
  });

  it("a chat page gets no task and no save target", async () => {
    window.history.pushState({}, "", "/PAR/chats/sam");
    await mount();
    await flush();
    expect(ctxOf(0)).toMatchObject({ kind: "chat", agentId: "a-dev" });
    expect(ctxOf(0).saveRef).toBeUndefined();
    expect(document.body.textContent).not.toContain("About PAR");
  });
});
