// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_TIMEOUT_MS,
  AccessGate,
  CORE_FORBIDDEN_MESSAGES,
  NO_ACCESS_TEXT,
  NoAccess,
  accessStateOf,
  isAccessForbidden,
  useAccess,
  type AccessLoader,
  type AccessState,
} from "../src/access.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "11111111-1111-4111-8111-111111111111";
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Renders a page and a sidebar entry gated by one `useAccess` call; returns the states the hook went through. */
function mount(load: AccessLoader, timeoutMs?: number): AccessState[] {
  const seen: AccessState[] = [];
  function Probe() {
    const state = useAccess(load, COMPANY, timeoutMs === undefined ? {} : { timeoutMs });
    seen.push(state as AccessState);
    return (
      <>
        <AccessGate state={state} kind="sidebar"><a data-testid="sidebar">Ads</a></AccessGate>
        <AccessGate state={state} kind="page" moduleName="Ads"><p data-testid="page">Campaigns</p></AccessGate>
      </>
    );
  }
  act(() => root.render(<Probe />));
  return seen;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("useAccess and AccessGate", () => {
  it("open: shows the page and the sidebar entry, and asks with the company", async () => {
    const load = vi.fn<AccessLoader>(async () => ({ mode: "enforce", open: true, permissions: [] }));
    const seen = mount(load);
    await flush();
    expect(load).toHaveBeenCalledWith({ companyId: COMPANY });
    expect(seen.at(-1)).toBe("open");
    expect(q("page")).not.toBeNull();
    expect(q("sidebar")).not.toBeNull();
  });

  it("closed: the page shows NoAccess, the sidebar entry renders nothing", async () => {
    mount(async () => ({ mode: "enforce", open: false, permissions: [] }));
    await flush();
    expect(q("page")).toBeNull();
    expect(q("sidebar")).toBeNull();
    expect(container.querySelector('[data-access-state="closed"]')?.textContent).toContain("You do not have access to Ads");
  });

  it("loading: nothing renders, so a sidebar entry does not flash", () => {
    const seen = mount(() => new Promise(() => {}));
    expect(seen.at(-1)).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("error: stays open (the guard, not the page, is the gate)", async () => {
    const seen = mount(async () => {
      throw { code: "WORKER_UNAVAILABLE", message: "Worker is not running" };
    });
    await flush();
    expect(seen.at(-1)).toBe("open");
    expect(q("page")).not.toBeNull();
  });

  it("a loader that throws synchronously also stays open", async () => {
    const seen = mount(() => {
      throw new Error("boom");
    });
    await flush();
    expect(seen.at(-1)).toBe("open");
  });

  it("timeout: stays open after the wait", async () => {
    vi.useFakeTimers();
    const seen = mount(() => new Promise(() => {}), 50);
    expect(seen.at(-1)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(seen.at(-1)).toBe("open");
    expect(q("sidebar")).not.toBeNull();
  });

  it("the default wait is the exported constant", async () => {
    vi.useFakeTimers();
    const load = vi.fn<AccessLoader>(() => new Promise(() => {}));
    const seen = mount(load);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACCESS_TIMEOUT_MS - 1);
    });
    expect(seen.at(-1)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(seen.at(-1)).toBe("open");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("403 (core viewer): closed", async () => {
    const seen = mount(async () => {
      throw { code: "UNKNOWN", message: "Viewer access is read-only" };
    });
    await flush();
    expect(seen.at(-1)).toBe("closed");
    expect(q("page")).toBeNull();
  });

  it("an answer after unmount is ignored", async () => {
    let answer!: (value: unknown) => void;
    mount(() => new Promise((resolve) => (answer = resolve)));
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => answer({ open: false }));
    expect(container.innerHTML).toBe("");
  });

  it("a new company asks again and shows nothing until it answers", async () => {
    const load = vi.fn<AccessLoader>(async ({ companyId }) => ({ open: companyId === COMPANY }));
    let switchTo!: (id: string) => void;
    function Probe() {
      const [companyId, setCompanyId] = useState(COMPANY);
      switchTo = setCompanyId;
      const state = useAccess(load, companyId);
      return <AccessGate state={state} kind="widget"><span data-testid="widget">ok</span></AccessGate>;
    }
    act(() => root.render(<Probe />));
    await flush();
    expect(q("widget")).not.toBeNull();
    act(() => switchTo("22222222-2222-4222-8222-222222222222"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(q("widget")).toBeNull();
  });
});

describe("reading the answer", () => {
  it("only open: false or a refusal closes", () => {
    expect(accessStateOf({ mode: "off", open: true, permissions: [] })).toBe("open");
    expect(accessStateOf({ mode: "enforce", open: false, permissions: [] })).toBe("closed");
    expect(accessStateOf({ ok: false, refused: true, code: "PERMISSION_DENIED", message: "No" })).toBe("closed");
    for (const odd of [null, undefined, "yes", 1, {}, { open: "false" }]) expect(accessStateOf(odd)).toBe("open");
  });

  it("knows core's 403 by status or by message, and nothing else", () => {
    expect(isAccessForbidden({ status: 403, message: "Forbidden" })).toBe(true);
    expect(isAccessForbidden({ statusCode: 403 })).toBe(true);
    for (const message of CORE_FORBIDDEN_MESSAGES) expect(isAccessForbidden({ code: "UNKNOWN", message })).toBe(true);
    expect(isAccessForbidden({ status: 500, message: "Internal" })).toBe(false);
    expect(isAccessForbidden({ code: "CAPABILITY_DENIED", message: "Plugin lacks capability" })).toBe(false);
    expect(isAccessForbidden(new Error("network"))).toBe(false);
    expect(isAccessForbidden(null)).toBe(false);
  });

  it("each 403 message still comes from core's company access check", () => {
    const authz = readFileSync(resolve(import.meta.dirname, "../../../../server/src/routes/authz.ts"), "utf8");
    for (const message of CORE_FORBIDDEN_MESSAGES) expect(authz).toContain(`forbidden("${message}")`);
  });
});

describe("NoAccess", () => {
  it("is one main landmark with the words and no record or link", () => {
    act(() => root.render(<NoAccess />));
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("h1")?.textContent).toBe(NO_ACCESS_TEXT.title);
    expect(container.textContent).toContain(NO_ACCESS_TEXT.body);
    expect(container.querySelector("a")).toBeNull();
  });
});
