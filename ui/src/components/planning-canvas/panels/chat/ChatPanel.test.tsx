// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const sendChat = vi.fn();
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { sendChat: (...a: unknown[]) => sendChat(...a), readActions: async () => ({ actions: [{ tool: "t", name: "T", description: null, application: null }] }) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: vi.fn(async () => []), listComments: vi.fn(async () => []) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForIssue: vi.fn(async () => []) } }));
vi.mock("@/components/planning-canvas/panels/sharing/useSessionUserId", () => ({ useSessionUserId: () => "u1" }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

import { ChatPanel } from "./ChatPanel";

const agents = [{ id: "a1", name: "Ada", status: "idle" }];
const nodeById = new Map([
  ["n1", { id: "n1", kind: "sticky", title: "Secret sticky text" }],
  ["n2", { id: "n2", kind: "sticky", title: "Second" }],
  ["f1", { id: "f1", kind: "frame", title: "Frame one" }],
]);
function controller(memberAccess: string, chatAsk: unknown = null): CanvasController {
  return {
    selectedCompanyId: "c1",
    agents,
    nodeById,
    chatAsk,
    activeBoard: { id: "b1", scope: "project", memberAccess },
  } as unknown as CanvasController;
}

let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sendChat.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function mount(access: string, chatAsk: unknown = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ChatPanel c={controller(access, chatAsk)} /></QueryClientProvider>);
  });
  const openBtn = container.querySelector('[data-testid="canvas-chat-open"]') as HTMLElement | null;
  if (openBtn) await act(async () => { openBtn.click(); });
}
async function pickAndType(text: string) {
  const select = container.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "a1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const ta = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const sendButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Send") as HTMLButtonElement;

describe("ChatPanel", () => {
  it("gives edit access a composer and view access a read-only panel", async () => {
    await mount("edit");
    expect(container.querySelector("textarea")).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await mount("view");
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[data-testid="canvas-chat-readonly"]')).not.toBeNull();
  });

  it("shows the connector picker to editors with an agent picked, not to viewers", async () => {
    await mount("edit");
    expect(container.querySelector('[data-testid="canvas-connector-picker"]')).toBeNull();
    await pickAndType("");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(container.querySelector('[data-testid="canvas-connector-picker"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await mount("view");
    expect(container.querySelector('[data-testid="canvas-connector-picker"]')).toBeNull();
  });

  it("hides the connector picker once chat is switched off", async () => {
    sendChat.mockRejectedValue(new ApiError("off", 403, {}, { code: "canvas_chat_disabled" }));
    await mount("edit");
    await pickAndType("hello");
    expect(container.querySelector('[data-testid="canvas-connector-picker"]')).not.toBeNull();
    await act(async () => { sendButton().click(); });
    expect(container.querySelector('[data-testid="canvas-connector-picker"]')).toBeNull();
  });

  it("comment access is read-only too", async () => {
    await mount("comment");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("says chat is off after the switch refusal and sends nothing more", async () => {
    sendChat.mockRejectedValue(new ApiError("off", 403, {}, { code: "canvas_chat_disabled" }));
    await mount("edit");
    await pickAndType("hello");
    await act(async () => { sendButton().click(); });
    expect(container.querySelector('[data-testid="canvas-chat-off"]')?.textContent).toContain("switched off");
    expect(container.querySelector("textarea")!.disabled).toBe(true);
    expect(sendChat).toHaveBeenCalledTimes(1);
  });

  it("shows a rate-limit refusal as a message and keeps the draft", async () => {
    sendChat.mockRejectedValue(new ApiError("slow", 429, {}, { code: "canvas_chat_rate_limited" }));
    await mount("edit");
    await pickAndType("hello");
    await act(async () => { sendButton().click(); });
    expect(container.querySelector('[data-testid="canvas-chat-notice"]')?.textContent).toContain("Wait a little");
    expect(container.querySelector("textarea")!.value).toBe("hello");
  });

  it("sends one clientRequestId for a double click and reuses it on retry", async () => {
    let release!: () => void;
    sendChat.mockImplementationOnce(() => new Promise((_, rej) => { release = () => rej(new ApiError("x", 500, {})); }));
    sendChat.mockResolvedValueOnce({ threadIssueId: "t1", threadIdentifier: "PAR-1", commentId: "m1", thread: "created", repeat: false });
    await mount("edit");
    await pickAndType("hello");
    await act(async () => { sendButton().click(); sendButton().click(); });
    expect(sendChat).toHaveBeenCalledTimes(1);
    const first = sendChat.mock.calls[0]![2].clientRequestId;
    expect(first).toBeTruthy();
    await act(async () => { release(); });
    await act(async () => { sendButton().click(); });
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]![2].clientRequestId).toBe(first);
  });

  it("shows selected nodes as chips, removing one drops its key, and the payload has keys only", async () => {
    sendChat.mockResolvedValue({ threadIssueId: "t1", threadIdentifier: "PAR-1", commentId: "m1", thread: "created", repeat: false });
    await mount("edit", { itemKeys: ["n1", "n2"], seq: 1 });
    expect(container.querySelectorAll('[data-testid="canvas-chat-chip"]')).toHaveLength(2);
    await act(async () => { (container.querySelector('button[aria-label="Remove Second"]') as HTMLElement).click(); });
    expect(container.querySelectorAll('[data-testid="canvas-chat-chip"]')).toHaveLength(1);
    await pickAndType("what is this?");
    await act(async () => { sendButton().click(); });
    const payload = sendChat.mock.calls[0]![2];
    expect(payload.context).toEqual({ itemKeys: ["n1"] });
    expect(JSON.stringify(payload)).not.toContain("Secret sticky text");
  });

  it("a frame ask sends frameKey", async () => {
    sendChat.mockResolvedValue({ threadIssueId: "t1", threadIdentifier: "PAR-1", commentId: "m1", thread: "created", repeat: false });
    await mount("edit", { itemKeys: [], frameKey: "f1", seq: 1 });
    expect(container.querySelector('[data-testid="canvas-chat-chip"]')?.textContent).toContain("Frame: Frame one");
    await pickAndType("summarise");
    await act(async () => { sendButton().click(); });
    expect(sendChat.mock.calls[0]![2].context).toEqual({ itemKeys: [], frameKey: "f1" });
  });

  it("sends no context when there are no chips", async () => {
    sendChat.mockResolvedValue({ threadIssueId: "t1", threadIdentifier: "PAR-1", commentId: "m1", thread: "created", repeat: false });
    await mount("edit");
    await pickAndType("hi");
    await act(async () => { sendButton().click(); });
    expect(sendChat.mock.calls[0]![2].context).toBeUndefined();
  });
});
