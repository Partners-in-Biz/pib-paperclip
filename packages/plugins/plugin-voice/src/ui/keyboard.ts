// Keep the focused field visible above the phone keyboard. The keyboard shrinks
// window.visualViewport, not the layout viewport, so we compare the field to it and scroll.
// Scroll only: the host composer's layout is never touched. No-op without visualViewport.

const FIELD = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const SKIP_INPUT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

function fieldOf(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>(FIELD) : null;
  if (!el) return null;
  if (el instanceof HTMLInputElement && SKIP_INPUT.has(el.type)) return null;
  return el;
}

export function keepFieldVisible(doc: Document = document): () => void {
  const win = doc.defaultView;
  const vv = win?.visualViewport;
  if (!win || !vv) return () => {};
  let active: HTMLElement | null = null;
  let frame = 0;

  const check = () => {
    frame = 0;
    if (!active || !active.isConnected) return;
    const visibleBottom = vv.offsetTop + vv.height;
    if (active.getBoundingClientRect().bottom <= visibleBottom) return;
    // block "start" puts the field near the top of the visible area.
    active.scrollIntoView({ block: "start", inline: "nearest" });
  };
  const schedule = () => {
    if (frame) return;
    // Wait a frame: the viewport finishes resizing after focus.
    frame = win.requestAnimationFrame(check);
  };
  const onFocusIn = (event: Event) => {
    active = fieldOf(event.target);
    if (active) schedule();
  };
  const onFocusOut = () => {
    active = null;
  };

  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    if (frame) win.cancelAnimationFrame(frame);
    active = null;
  };
}
