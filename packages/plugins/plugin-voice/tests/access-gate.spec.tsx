// @vitest-environment jsdom
/**
 * The overlay's gate (access stage A, spec PAR-12578 section 4.6 and 8.1 "for Voice: no mic in the chat box"; PAR-12678):
 * `VoiceOverlay` rendered for real with a chat composer on the page and `access.me` answering closed or open. Closed:
 * no mic and no live button in the composer, and no `status` read. Taking `AccessGate` off the overlay fails this spec.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const access = vi.hoisted(() => ({ answer: { mode: "enforce", open: false, permissions: [] as string[] } as unknown }));
const calls = vi.hoisted(() => ({ data: [] as string[] }));

vi.mock("../src/ui/actions.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/ui/actions.js")>();
  // Stable, as the host's hooks are: a new loader each render would re-run the access check.
  const loadAccess = async () => real.voiceAccess(access.answer);
  const action = async () => ({});
  return { ...real, useAccessMe: () => loadAccess, useVoiceAction: () => action };
});
vi.mock("../src/ui/recorder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/recorder.js")>()),
  voiceSupported: () => true,
}));
vi.mock("@paperclipai/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/plugin-sdk/ui")>()),
  useHostContext: () => ({ companyId: COMPANY, userId: "u-1" }),
  usePluginData: (key: string) => {
    calls.data.push(key);
    return { data: { configured: true, liveEnabled: true, voiceNoteAutoSend: false }, loading: false, error: null, refresh: () => {} };
  },
}));

const { VoiceOverlay } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.data.length = 0;
  document.body.innerHTML = `<div data-testid="chat-composer"><textarea></textarea><div><button aria-label="Send message">s</button></div></div>`;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function render() {
  act(() => root.render(<VoiceOverlay />));
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const mic = () => document.querySelector('[aria-label="Record a voice note"]');
const live = () => document.querySelector('[aria-label="Talk live with your agents"]');

describe("Voice overlay gate", () => {
  it("closed: no mic and no live button in the chat box, and no status read", async () => {
    access.answer = { mode: "enforce", open: false, permissions: [] };
    await render();
    expect(mic()).toBeNull();
    expect(live()).toBeNull();
    expect(calls.data).toEqual([]);
  });

  it("voice.settings without voice.use: no mic either", async () => {
    access.answer = { mode: "enforce", open: true, permissions: ["voice.settings:view", "voice.settings:edit"] };
    await render();
    expect(mic()).toBeNull();
  });

  it("open (switch off, or granted voice.use): the mic and the live button are in the chat box", async () => {
    access.answer = { mode: "off", open: true, permissions: ["voice.use:view", "voice.use:create", "voice.settings:view", "voice.settings:edit"] };
    await render();
    expect(mic()).not.toBeNull();
    expect(live()).not.toBeNull();
    expect(calls.data).toContain("status");
  });
});
