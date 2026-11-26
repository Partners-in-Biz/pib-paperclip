// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasActions, WEBLINK_HTTP_MESSAGE, WEBLINK_INVALID_MESSAGE, type CanvasActions } from "./useCanvasActions";
import { pastedLink, useCanvasPaste } from "./useCanvasPaste";

vi.mock("@/api/personalNotes", () => ({ personalNotesApi: {} }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Board = { id: string; scope: string; memberAccess?: string } | null;

async function mount(activeBoard: Board = { id: "b1", scope: "personal" }) {
  const addItem = vi.fn();
  const pushToast = vi.fn();
  const ctx = {
    nodes: [], connectors: [], notesSearch: "", personalNotes: [], notesById: new Map(),
    viewport: { x: 0, y: 0, zoom: 1 }, canvasRef: { current: null },
    selectedNodeIds: [], setSelectedNodeIds: vi.fn(), setTool: vi.fn(),
    opStore: { addItem }, activeBoard, pushToast,
  };
  let actions: CanvasActions | undefined;
  function Harness() {
    actions = useCanvasActions(ctx as never);
    useCanvasPaste({ ...ctx, ...actions } as never);
    return null;
  }
  await act(async () => root.render(<Harness />));
  return { actions: actions!, addItem, pushToast };
}

function paste(text: string, target: EventTarget = document.body) {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("insertWebLinkNode", () => {
  it("stores url only, at the view centre, sized for a video or a link", async () => {
    const { actions, addItem } = await mount();
    expect(actions.insertWebLinkNode("  https://youtu.be/dQw4w9WgXcQ ")).toBeNull();
    expect(actions.insertWebLinkNode("https://example.com/a")).toBeNull();
    const [[, video], [, link]] = addItem.mock.calls;
    expect(video.kind).toBe("weblink");
    expect(video.data).toStrictEqual({ url: "https://youtu.be/dQw4w9WgXcQ" });
    expect([video.width, video.height]).toEqual([400, 300]);
    expect(link.data).toStrictEqual({ url: "https://example.com/a" });
    expect([link.width, link.height]).toEqual([300, 132]);
  });

  it("refuses http and anything the web link rule refuses", async () => {
    const { actions, addItem } = await mount();
    expect(actions.insertWebLinkNode("http://example.com")).toBe(WEBLINK_HTTP_MESSAGE);
    expect(actions.insertWebLinkNode("HTTP://example.com")).toBe(WEBLINK_HTTP_MESSAGE);
    for (const url of ["javascript:alert(1)", "https://user@example.com/", "example.com", ""]) {
      expect(actions.insertWebLinkNode(url), url).toBe(WEBLINK_INVALID_MESSAGE);
    }
    expect(addItem).not.toHaveBeenCalled();
  });
});

describe("board paste (PAR-14389 C.5)", () => {
  it("one https link pasted with no field focused becomes a card", async () => {
    const { addItem, pushToast } = await mount();
    const event = paste("https://example.com/page\n");
    expect(event.defaultPrevented).toBe(true);
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem.mock.calls[0]![1].data).toStrictEqual({ url: "https://example.com/page" });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("an http link makes no card and says why", async () => {
    const { addItem, pushToast } = await mount();
    paste("http://example.com/page");
    expect(addItem).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith({ title: "Only https links can be cards", tone: "warn" });
  });

  it("is ignored while a text field has focus", async () => {
    const { addItem, pushToast } = await mount();
    for (const tag of ["input", "textarea"] as const) {
      const field = document.createElement(tag);
      document.body.append(field);
      field.focus();
      const event = paste("https://example.com/page", field);
      expect(event.defaultPrevented).toBe(false);
      field.remove();
    }
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(editable);
    paste("https://example.com/page", editable);
    editable.remove();
    expect(addItem).not.toHaveBeenCalled();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("leaves text that is not exactly one link, and boards the reader cannot edit, alone", async () => {
    const { addItem } = await mount();
    for (const text of ["hello", "see https://example.com", "https://a.test https://b.test", ""]) {
      expect(paste(text).defaultPrevented, text).toBe(false);
    }
    expect(addItem).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    const viewer = await mount({ id: "b2", scope: "project", memberAccess: "view" });
    expect(paste("https://example.com").defaultPrevented).toBe(false);
    expect(viewer.addItem).not.toHaveBeenCalled();
  });

  it("pastedLink accepts one http(s) token only", () => {
    expect(pastedLink(" https://example.com/x ")).toBe("https://example.com/x");
    expect(pastedLink("http://example.com")).toBe("http://example.com");
    expect(pastedLink("ftp://example.com")).toBeNull();
    expect(pastedLink("https://example.com x")).toBeNull();
  });
});
