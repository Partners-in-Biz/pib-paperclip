// @vitest-environment jsdom
/**
 * The agent Voice tab's gate (PAR-12707): `AgentVoiceTab` rendered for real with `access.me` answering closed or open.
 * Making `voiceTabAccess` always open fails the "other permission" case.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ answer: {} as unknown }));
const calls = vi.hoisted(() => ({ data: [] as string[] }));

vi.mock("../src/ui/actions.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ui/actions.js")>();
  // Stable, as the host's hooks are: a new loader each render would re-run the access check.
  const loadAccess = async () => real.voiceTabAccess(access.answer);
  const action = async () => ({});
  return { ...real, useTabAccessMe: () => loadAccess, useVoiceAction: () => action };
});
vi.mock("@paperclipai/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk/ui")>()),
  usePluginData: (key: string) => {
    calls.data.push(key);
    return {
      data: { profile: {}, company: { grokVoice: "eve", geminiVoice: "Kore" }, geminiConfigured: false, voices: { grok: ["eve"], gemini: [] } },
      loading: false,
      error: null,
      refresh: () => {},
    };
  },
}));

const { AgentVoiceTab } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.data.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ name: "Ren" }) })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  const context = { companyId: "c-1", entityId: "a-1", entityType: "agent" } as never;
  act(() => root.render(<AgentVoiceTab context={context} />));
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}
const tab = () => container.querySelector("#agent-voice-grok");

describe("Voice tab gate", () => {
  it("closed: no tab body and no agent-voice read", async () => {
    access.answer = { mode: "enforce", open: false, permissions: [] };
    await render();
    expect(tab()).toBeNull();
    expect(calls.data).toEqual([]);
  });

  it("open but with another permission only: no tab body, no read", async () => {
    access.answer = { mode: "enforce", open: true, permissions: ["voice.admin:read"] };
    await render();
    expect(tab()).toBeNull();
    expect(calls.data).toEqual([]);
  });

  it("voice.use:create alone opens the tab", async () => {
    access.answer = { mode: "enforce", open: true, permissions: ["voice.use:create"] };
    await render();
    expect(tab()).not.toBeNull();
    expect(calls.data).toContain("agent-voice");
  });

  it("voice.settings:edit alone opens the tab", async () => {
    access.answer = { mode: "enforce", open: true, permissions: ["voice.settings:edit"] };
    await render();
    expect(tab()).not.toBeNull();
  });

  it("an open answer with no permissions listed (access unreadable) stays open, as the kit returns it", async () => {
    access.answer = { mode: "off", open: true, permissions: [] };
    await render();
    expect(tab()).not.toBeNull();
  });
});
