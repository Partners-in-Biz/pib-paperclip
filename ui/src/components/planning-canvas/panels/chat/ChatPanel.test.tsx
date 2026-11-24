// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const sendChat = vi.fn();
vi.mock("@/api/planningCanvases", () => ({ planningCanvasesApi: { sendChat: (...a: unknown[]) => sendChat(...a) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: vi.fn(async () => []), listComments: vi.fn(async () => []) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForIssue: vi.fn(async () => []) } }));
vi.mock("@/components/planning-canvas/panels/sharing/useSessionUserId", () => ({ useSessionUserId: () => "u1" }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));

import { ChatPanel } from "./ChatPanel";

const agents = [{ id: "a1", name: "Ada", status: "idle" }];
function controller(memberAccess: string): CanvasController {
  return {
    selectedCompanyId: "c1",
    agents,
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

async function mount(access: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ChatPanel c={controller(access)} /></QueryClientProvider>);
  });
  await act(async () => { (container.querySelector('[data-testid="canvas-chat-open"]') as HTMLElement).click(); });
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
});
