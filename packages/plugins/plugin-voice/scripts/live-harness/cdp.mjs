// Minimal CDP client over Node's global WebSocket (Node >= 22). No dependencies.

/** `http://host:9222` opens a new page target; a `ws://` URL is used as is. */
export async function connectPage(cdpUrl, startUrl = "about:blank") {
  let ws = cdpUrl;
  if (!/^wss?:/.test(cdpUrl)) {
    const res = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/new?${encodeURI(startUrl)}`, { method: "PUT" });
    if (!res.ok) throw new Error(`CDP /json/new answered ${res.status}`);
    ws = (await res.json()).webSocketDebuggerUrl;
  }
  return openSession(ws);
}

export function openSession(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    const waiter = msg.id !== undefined ? pending.get(msg.id) : null;
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      pending.set(nextId, { resolve, reject, method });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  /** Evaluates an expression (awaiting a promise) and returns its JSON value; a page exception throws. */
  const evaluate = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(`page: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
    return out.result.value;
  };
  /** A real mouse click (trusted event, user activation) at the centre of the first element matching `selector`. */
  const click = async (selector) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`no element for ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  };
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`CDP socket failed: ${wsUrl}`)));
  });
  return ready.then(() => ({ send, evaluate, click, close: () => socket.close() }));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` every `everyMs` until it answers a truthy value or `timeoutMs` passes (then null). */
export async function waitFor(fn, timeoutMs, everyMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= until) return null;
    await sleep(everyMs);
  }
}
