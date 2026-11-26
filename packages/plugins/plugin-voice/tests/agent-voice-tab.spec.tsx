// @vitest-environment jsdom
/** The Voice tab on the agent page (plan PAR-14808, T5): save and reload, Play sample per provider, Gemini hidden until configured. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "a4f00000-0000-4000-8000-0000000000a1";
const GROK = ["carina", "zagan", "eve", "rex"];
const GEMINI = ["Zephyr", "Puck", "Kore"];
const state = vi.hoisted(() => ({
  profile: {} as Record<string, string>,
  geminiConfigured: true,
  calls: [] as Array<{ key: string; params: Record<string, unknown> }>,
  speakAnswer: { audio: "AAAA", sampleRate: 24000 } as Record<string, unknown>,
  played: [] as number[],
  version: 0,
}));

vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  usePluginData: () => ({
    data: {
      profile: state.profile,
      company: { grokVoice: "eve", geminiVoice: "Kore" },
      geminiConfigured: state.geminiConfigured,
      voices: { grok: GROK, gemini: GEMINI },
    },
    loading: false,
    error: null,
    refresh: () => bump(),
  }),
}));
vi.mock("../src/ui/actions.js", () => ({
  useVoiceAction: (key: string) => async (params: Record<string, unknown>) => {
    state.calls.push({ key, params });
    if (key === "speak") return state.speakAnswer;
    // The worker's own rules: a missing field is unchanged, an empty one is cleared.
    for (const field of ["grokVoice", "geminiVoice", "geminiStyle"]) {
      if (!(field in params)) continue;
      if (params[field]) state.profile = { ...state.profile, [field]: params[field] as string };
      else delete state.profile[field];
    }
    return { profile: state.profile };
  },
}));
vi.mock("../src/ui/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/audio.js")>()),
  Player: class {
    enqueue(pcm: ArrayBuffer) {
      state.played.push(pcm.byteLength);
    }
  },
}));

const { AgentVoiceTabBody } = await import("../src/ui/agent-voice-tab.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let rerender: () => void = () => {};
function bump() {
  state.version += 1;
  rerender();
}
const LONG_NAME = "Ren the Extraordinarily Long Named Agent of Many Departments and Seasons";

function mount() {
  const tree = () => <AgentVoiceTabBody context={{ companyId: "c-1", companyPrefix: null, projectId: null, entityId: AGENT, entityType: "agent", userId: "u-1" } as never} />;
  rerender = () => act(() => root.render(tree()));
  rerender();
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const byId = <T extends HTMLElement>(id: string) => container.querySelector<T>(`#${id}`);
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text))!;
async function choose(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

beforeEach(() => {
  state.profile = {};
  state.geminiConfigured = true;
  state.calls.length = 0;
  state.played.length = 0;
  state.speakAnswer = { audio: "AAAA", sampleRate: 24000 };
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ name: LONG_NAME }) })));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentVoiceTabBody", () => {
  it("saves a profile and shows it again after a reload", async () => {
    mount();
    await settle();
    await choose(byId<HTMLSelectElement>("agent-voice-grok")!, "rex");
    await choose(byId<HTMLSelectElement>("agent-voice-gemini")!, "Puck");
    await choose(byId<HTMLInputElement>("agent-voice-style")!, "calm and warm");
    await act(async () => button("Save").click());
    await settle();
    expect(state.calls).toEqual([{ key: "set-agent-voice-profile", params: { agentId: AGENT, grokVoice: "rex", geminiVoice: "Puck", geminiStyle: "calm and warm" } }]);
    expect(state.profile).toEqual({ grokVoice: "rex", geminiVoice: "Puck", geminiStyle: "calm and warm" });

    // A fresh mount reads the saved profile back.
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    await settle();
    expect(byId<HTMLSelectElement>("agent-voice-grok")!.value).toBe("rex");
    expect(byId<HTMLSelectElement>("agent-voice-gemini")!.value).toBe("Puck");
    expect(byId<HTMLInputElement>("agent-voice-style")!.value).toBe("calm and warm");
    expect((button("Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("plays a sample per provider with the agent's name", async () => {
    state.profile = { grokVoice: "rex", geminiVoice: "Puck" };
    mount();
    await settle();
    const plays = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Play sample");
    expect(plays).toHaveLength(2);
    await act(async () => plays[0]!.click());
    await settle();
    await act(async () => plays[1]!.click());
    await settle();
    expect(state.calls).toEqual([
      { key: "speak", params: { agentId: AGENT, provider: "grok", text: `Hi, I'm ${LONG_NAME}.` } },
      { key: "speak", params: { agentId: AGENT, provider: "gemini", text: `Hi, I'm ${LONG_NAME}.` } },
    ]);
    expect(state.played).toHaveLength(2);
  });

  it("says so when a sample cannot play", async () => {
    state.speakAnswer = { error: "rate_limited" };
    mount();
    await settle();
    await act(async () => button("Play sample").click());
    await settle();
    expect(state.played).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("busy");
  });

  it("hides the Gemini controls with the reason when Gemini is not configured", async () => {
    state.geminiConfigured = false;
    state.profile = { geminiVoice: "Puck" };
    mount();
    await settle();
    expect(byId("agent-voice-gemini")).toBeNull();
    expect(byId("agent-voice-style")).toBeNull();
    expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Play sample")).toHaveLength(1);
    expect(container.textContent).toContain("Gemini voices appear here once a Gemini key is set in Voice settings");
    // Saving here never touches the Gemini fields.
    await choose(byId<HTMLSelectElement>("agent-voice-grok")!, "eve");
    await act(async () => button("Save").click());
    await settle();
    expect(state.calls[0]!.params).toEqual({ agentId: AGENT, grokVoice: "eve" });
  });

  it("lists every voice it is given", async () => {
    mount();
    await settle();
    expect(byId<HTMLSelectElement>("agent-voice-grok")!.options).toHaveLength(GROK.length + 1);
    expect(byId<HTMLSelectElement>("agent-voice-gemini")!.options).toHaveLength(GEMINI.length + 1);
  });
});
