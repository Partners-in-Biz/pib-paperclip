/**
 * Finds Paperclip's chat boxes in the page and gives each one a mount point for
 * the voice buttons, right before its Send button.
 *
 * The host has no composer slot, so this works from the composers' stable
 * `data-testid`s. Every composer the host renders is matched by one of the
 * selectors below; if a host release renames them the buttons simply do not
 * appear (nothing breaks).
 */

export const MOUNT_ATTR = "data-pib-voice-mount";

/** Composer roots: board chat, issue thread, task chat (its action row). */
export const COMPOSER_SELECTORS = [
  '[data-testid="chat-composer"]',
  '[data-testid="issue-chat-composer"]',
  '[data-testid="task-chat-composer-actions"]',
] as const;

export interface ComposerTarget {
  /** Element the selector matched. */
  root: HTMLElement;
  /** Where the text goes: a textarea or the rich editor's contenteditable. */
  editable: HTMLElement | null;
  /** Send (or Stop) button the voice buttons sit in front of. */
  sendButton: HTMLButtonElement | null;
}

function isOurs(el: Element): boolean {
  return !!el.closest(`[${MOUNT_ATTR}]`);
}

/** The task chat's action row sits beside the editor, not around it. */
function editorScope(root: HTMLElement): HTMLElement {
  if (root.dataset.testid !== "task-chat-composer-actions") return root;
  let node: HTMLElement | null = root.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (node.querySelector('[data-testid="task-chat-composer-input"]')) return node;
  }
  return root.parentElement ?? root;
}

export function findEditable(root: HTMLElement): HTMLElement | null {
  const scope = editorScope(root);
  const candidates = scope.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]');
  for (const el of candidates) {
    if (!isOurs(el)) return el;
  }
  return null;
}

export function findSendButton(root: HTMLElement): HTMLButtonElement | null {
  const explicit = root.querySelector<HTMLButtonElement>(
    '[data-testid="task-chat-composer-send"], [data-testid="task-chat-composer-stop"]',
  );
  if (explicit) return explicit;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => !isOurs(b) && !b.closest('[data-testid$="-attachments"]') && !b.closest('[role="dialog"]'),
  );
  return buttons.length > 0 ? buttons[buttons.length - 1]! : null;
}

export function describeComposer(root: HTMLElement): ComposerTarget {
  return { root, editable: findEditable(root), sendButton: findSendButton(root) };
}

export function findComposers(doc: ParentNode): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(COMPOSER_SELECTORS.join(", ")));
}

/**
 * Returns the mount element for a composer, creating or moving it so it sits
 * immediately before the Send button. React keeps its own nodes in order and
 * leaves foreign siblings alone, so the mount survives re-renders; when React
 * replaces the row, the caller sees `isConnected === false` and asks again.
 */
export function ensureMount(root: HTMLElement): HTMLElement {
  const send = findSendButton(root);
  let mount = root.querySelector<HTMLElement>(`[${MOUNT_ATTR}]`);
  if (!mount) {
    mount = root.ownerDocument.createElement("span");
    mount.setAttribute(MOUNT_ATTR, "");
    mount.style.display = "inline-flex";
    mount.style.alignItems = "center";
    mount.style.gap = "2px";
    mount.style.flexShrink = "0";
  }
  if (send?.parentElement) {
    if (mount.nextElementSibling !== send || mount.parentElement !== send.parentElement) {
      send.parentElement.insertBefore(mount, send);
    }
  } else if (mount.parentElement !== root) {
    root.appendChild(mount);
  }
  return mount;
}

/** How to join a transcript onto what is already typed. */
export function joinText(existing: string, addition: string): string {
  const add = addition.trim();
  if (!add) return existing;
  const base = existing.replace(/\s+$/, "");
  if (!base) return add;
  return `${base}${/\n\s*$/.test(existing) ? "\n" : " "}${add}`;
}

/**
 * Puts text into the composer the way typing would, so the host's React state
 * sees it. Textareas need the native value setter plus an input event; the rich
 * editor (Lexical) takes `insertText` at the caret.
 */
export function insertIntoEditable(editable: HTMLElement, text: string): boolean {
  if (!text.trim()) return false;
  if (editable instanceof HTMLTextAreaElement) {
    const next = joinText(editable.value, text);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(editable, next);
    else editable.value = next;
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    editable.focus();
    editable.setSelectionRange(next.length, next.length);
    return true;
  }
  const doc = editable.ownerDocument;
  editable.focus();
  const selection = doc.getSelection();
  if (selection) {
    const range = doc.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const existing = (editable.textContent ?? "").trim();
  const piece = existing ? ` ${text.trim()}` : text.trim();
  // execCommand is deprecated but is still the one path every editor treats as typing.
  const ok = typeof doc.execCommand === "function" && doc.execCommand("insertText", false, piece);
  if (!ok) {
    editable.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: piece, bubbles: true, cancelable: true }));
  }
  return true;
}

/** Issue the page is showing, from a URL like /PAR/issues/PAR-123. */
export function issueRefFromPath(pathname: string): string | null {
  const match = /\/issues\/([A-Za-z][A-Za-z0-9]*-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(pathname);
  return match ? match[1]!.toUpperCase().replace(/^([0-9A-F-]{36})$/, (id) => id.toLowerCase()) : null;
}
