// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeComposer,
  ensureMount,
  findComposers,
  insertIntoEditable,
  issueRefFromPath,
  joinText,
  MOUNT_ATTR,
} from "../src/ui/composers.js";

/** Shapes copied from the host's ChatComposer, IssueChatThread and TaskChatComposer. */
const BOARD_CHAT = `
  <div data-testid="chat-composer">
    <textarea data-testid="chat-composer-input"></textarea>
    <div class="row">
      <button aria-label="Attach files">a</button>
      <span class="flex-1"></span>
      <button aria-label="Send message" id="send">s</button>
    </div>
  </div>`;

const ISSUE_THREAD = `
  <div data-testid="issue-chat-composer">
    <div contenteditable="true" id="editor"></div>
    <div data-testid="issue-chat-composer-attachments"><button>remove</button></div>
    <div class="row">
      <button data-testid="issue-chat-composer-work-mode-toggle">mode</button>
      <button id="send">Send</button>
    </div>
  </div>`;

const TASK_CHAT = `
  <div class="stack">
    <div data-testid="task-chat-composer-input"><div contenteditable="true" id="editor"></div></div>
    <div data-testid="task-chat-composer-actions">
      <button data-testid="task-chat-composer-attach">+</button>
      <button>mode</button>
      <button data-testid="task-chat-composer-send" id="send">send</button>
    </div>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("finding composers", () => {
  it.each([
    ["board chat", BOARD_CHAT, "TEXTAREA"],
    ["issue thread", ISSUE_THREAD, "DIV"],
    ["task chat", TASK_CHAT, "DIV"],
  ])("%s: finds the editor and the Send button", (_name, html, editorTag) => {
    document.body.innerHTML = html;
    const [root] = findComposers(document);
    expect(root).toBeTruthy();
    const target = describeComposer(root!);
    expect(target.editable?.tagName).toBe(editorTag);
    expect(target.sendButton?.id).toBe("send");
  });

  it("places the mount right before Send and keeps it there on re-scan", () => {
    document.body.innerHTML = TASK_CHAT;
    const [root] = findComposers(document);
    const mount = ensureMount(root!);
    const send = document.getElementById("send")!;
    expect(mount.nextElementSibling).toBe(send);
    // Our own buttons inside the mount never count as the Send button.
    mount.innerHTML = "<button>mic</button><button>live</button>";
    expect(ensureMount(root!)).toBe(mount);
    expect(describeComposer(root!).sendButton).toBe(send);
    expect(root!.querySelectorAll(`[${MOUNT_ATTR}]`)).toHaveLength(1);
  });

  it("moves the mount when the host swaps Send for Stop", () => {
    document.body.innerHTML = BOARD_CHAT;
    const [root] = findComposers(document);
    const mount = ensureMount(root!);
    const row = root!.querySelector(".row")!;
    document.getElementById("send")!.remove();
    const stop = document.createElement("button");
    stop.id = "stop";
    row.appendChild(stop);
    ensureMount(root!);
    expect(mount.nextElementSibling).toBe(stop);
  });

  it("ignores attachment chip buttons when picking Send", () => {
    document.body.innerHTML = ISSUE_THREAD;
    const [root] = findComposers(document);
    expect(describeComposer(root!).sendButton?.textContent).toBe("Send");
  });
});

describe("inserting text", () => {
  it("fills a React textarea through the native setter and an input event", () => {
    document.body.innerHTML = BOARD_CHAT;
    const textarea = document.querySelector("textarea")!;
    textarea.value = "Hi team";
    const onInput = vi.fn();
    textarea.addEventListener("input", onInput);
    expect(insertIntoEditable(textarea, "please check PAR-12")).toBe(true);
    expect(textarea.value).toBe("Hi team please check PAR-12");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("types into a contenteditable at the end", () => {
    document.body.innerHTML = ISSUE_THREAD;
    const editor = document.getElementById("editor")!;
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    expect(insertIntoEditable(editor, "status update please")).toBe(true);
    expect(exec).toHaveBeenCalledWith("insertText", false, "status update please");
  });

  it("does nothing for an empty transcript", () => {
    document.body.innerHTML = BOARD_CHAT;
    expect(insertIntoEditable(document.querySelector("textarea")!, "   ")).toBe(false);
  });

  it("joins onto existing text sensibly", () => {
    expect(joinText("", " hello ")).toBe("hello");
    expect(joinText("Hi  ", "there")).toBe("Hi there");
    expect(joinText("Line\n", "next")).toBe("Line\nnext");
    expect(joinText("keep", "")).toBe("keep");
  });
});

describe("issueRefFromPath", () => {
  it("reads the task from the URL", () => {
    expect(issueRefFromPath("/PAR/issues/PAR-123")).toBe("PAR-123");
    expect(issueRefFromPath("/par/issues/par-9/plan")).toBe("PAR-9");
    expect(issueRefFromPath("/PAR/issues/3f2b1c4d-1111-4222-8333-444455556666")).toBe("3f2b1c4d-1111-4222-8333-444455556666");
    expect(issueRefFromPath("/PAR/dashboard")).toBeNull();
    expect(issueRefFromPath("/PAR/issues")).toBeNull();
  });
});

describe("auto-send target", () => {
  it("is null when no real Send button exists", () => {
    document.body.innerHTML = '<div data-testid="chat-composer"><textarea></textarea><div class="row"><button id="clip">+</button></div></div>';
    const [root] = findComposers(document);
    expect(describeComposer(root!).sendButton).toBeNull();
  });
});

describe("auto-send never clicks Stop", () => {
  it("returns null while only the host's Stop control is present, but still anchors on it", () => {
    document.body.innerHTML =
      '<div data-testid="chat-composer"><textarea></textarea><div class="row"><button data-testid="task-chat-composer-stop" id="stop">Stop</button></div></div>';
    const [root] = findComposers(document);
    expect(describeComposer(root!).sendButton).toBeNull();
    const mount = ensureMount(root!);
    expect(mount.nextElementSibling).toBe(document.getElementById("stop"));
  });
});
