// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceAvatars } from "@/components/planning-canvas/realtime/PresenceAvatars";
import { RealtimeOverlay } from "@/components/planning-canvas/realtime/RealtimeOverlay";
import type { PresencePeer, RealtimeActor } from "@/components/planning-canvas/realtime/realtime-protocol";
import { FLASH_MS, RealtimeView, initialsOf, peerColor } from "@/components/planning-canvas/realtime/realtime-view";
import { RevokedNotice } from "@/components/planning-canvas/realtime/RevokedNotice";

const ada: RealtimeActor = { type: "user", id: "u-ada" };
const bot: RealtimeActor = { type: "agent", id: "a-bot" };
const peer = (clientId: string, actor: RealtimeActor, over: Partial<PresencePeer> = {}): PresencePeer => ({
  clientId, actor, cursor: null, selection: [], viewport: null, ...over,
});
const labels: Record<string, string> = { "u-ada": "Ada Lovelace", "a-bot": "Planner Bot" };
const node = (id: string) => ({ id, kind: "sticky", x: 100, y: 200, width: 260, height: 180, zIndex: 3, color: "yellow", title: "", content: "" });

function controller(view: RealtimeView, over: Record<string, unknown> = {}) {
  return {
    realtime: { view, labelFor: (actor: RealtimeActor) => labels[actor.id] ?? "Someone", status: "live", revoked: false, leaveRevokedBoard: () => undefined, ...over },
    nodeById: new Map([["n1", node("n1")]]),
    viewport: { x: 0, y: 0, zoom: 2 },
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeView", () => {
  it("tracks peers from snapshot, update and leave, never itself", () => {
    const view = new RealtimeView();
    view.applyPresence({ type: "presence.snapshot", clientId: "me", level: "edit", peers: [peer("me", ada), peer("c1", ada)] });
    expect(view.getSnapshot().peers.map((p) => p.clientId)).toEqual(["c1"]);
    view.applyPresence({ type: "presence.update", ...peer("c2", bot, { cursor: { x: 1, y: 2 } }) });
    expect(view.getSnapshot().peers.map((p) => p.clientId)).toEqual(["c1", "c2"]);
    view.applyPresence({ type: "presence.leave", clientId: "c1" });
    expect(view.getSnapshot().peers.map((p) => p.clientId)).toEqual(["c2"]);
    view.clearPeers();
    expect(view.getSnapshot().peers).toEqual([]);
  });

  it("an agent flash lasts 2 s", async () => {
    const view = new RealtimeView();
    view.flash(["n1"], bot);
    expect(view.getSnapshot().flashes.get("n1")?.actor).toEqual(bot);
    await vi.advanceTimersByTimeAsync(FLASH_MS - 1);
    expect(view.getSnapshot().flashes.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.getSnapshot().flashes.size).toBe(0);
  });

  it("gives one person the same colour in every tab", () => {
    expect(peerColor(ada)).toBe(peerColor({ type: "user", id: "u-ada" }));
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  ")).toBe("?");
  });
});

describe("overlay and avatars", () => {
  it("draws remote cursors with names, remote selections, and the agent flash label", () => {
    const view = new RealtimeView();
    view.applyPresence({ type: "presence.snapshot", clientId: "me", level: "edit", peers: [peer("c1", ada, { cursor: { x: 40, y: 50 }, selection: ["n1", "gone"] })] });
    view.flash(["n1", "deleted-node"], bot);
    const html = renderToStaticMarkup(<RealtimeOverlay c={controller(view)} />);
    expect(html.match(/planning-canvas-remote-cursor/g)).toHaveLength(1);
    expect(html).toContain("translate3d(40px, 50px, 0) scale(0.5)");
    expect(html).toContain("Ada Lovelace");
    expect(html.match(/planning-canvas-remote-selection/g)).toHaveLength(1);
    expect(html.match(/planning-canvas-agent-flash/g)).toHaveLength(1);
    expect(html).toContain("Planner Bot");
  });

  it("renders nothing with nobody else on the board", () => {
    expect(renderToStaticMarkup(<RealtimeOverlay c={controller(new RealtimeView())} />)).toBe("");
  });

  it("shows one avatar per person however many tabs they have, and Reconnecting while down", () => {
    const view = new RealtimeView();
    view.applyPresence({ type: "presence.snapshot", clientId: "me", level: "edit", peers: [peer("c1", ada), peer("c2", ada), peer("c3", bot)] });
    const html = renderToStaticMarkup(<PresenceAvatars c={controller(view, { status: "reconnecting" })} />);
    expect(html.match(/planning-canvas-avatar"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Ada Lovelace"');
    expect(html).toContain("Reconnecting…");
  });

  it("the revoked notice replaces the board with a message", () => {
    const view = new RealtimeView();
    expect(renderToStaticMarkup(<RevokedNotice c={controller(view)} />)).toBe("");
    const html = renderToStaticMarkup(<RevokedNotice c={controller(view, { revoked: true })} />);
    expect(html).toContain("You no longer have access to this board");
    expect(html).toContain("Back to boards");
  });
});
