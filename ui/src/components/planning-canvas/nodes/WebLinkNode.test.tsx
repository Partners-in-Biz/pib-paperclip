// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planningCanvasOpBatchSchema } from "@paperclipai/shared";
import { typedMetaOf } from "@/components/planning-canvas/nodes/typed-meta";
import { WebLinkNode, youTubeEmbedSrc } from "./WebLinkNode";

const ID = "dQw4w9WgXcQ";
const NOCOOKIE = `https://www.youtube-nocookie.com/embed/${ID}`;

/** The D1a hostile forms (plan PAR-14389 E) plus the accepted YouTube forms. */
const FORMS = [
  `https://www.youtube.com/watch?v=${ID}`,
  `https://youtu.be/${ID}?t=42`,
  `https://m.youtube.com/shorts/${ID}`,
  `https://www.youtube.com/embed/${ID}?autoplay=1&mute=1&origin=https://evil.test`,
  `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&controls=0`,
  `https://youtube.com.evil.test/watch?v=${ID}`,
  `https://evil.test/youtube.com/watch?v=${ID}`,
  `https://evil.test/watch?v=${ID}&host=youtube.com`,
  `https://evil.test#youtube.com/watch?v=${ID}`,
  `https://youtu.be.evil.test/${ID}`,
  `https://www.youtube.com:8443/watch?v=${ID}`,
  `https://www.youtube.com/watch?v=${ID}x`,
  `https://www.youtube.com/watch?v=${ID}%22`,
  `https://www.youtube.com/embed/${ID}/extra`,
  `https://www.youtube.com/watch?v=${ID}&v=${ID}`,
  `https://www.youtube.com/embed/%64Qw4w9WgXcQ`,
  `http://www.youtube.com/watch?v=${ID}`,
  `javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`,
  `https://user@www.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com/watch?v=${ID}&pad=${"a".repeat(2000)}`,
  `data:text/html,<iframe src="https://www.youtube.com/embed/${ID}">`,
];

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
  vi.unstubAllGlobals();
});

async function renderRaw(data: unknown) {
  const meta = typedMetaOf({ itemType: "node", fields: { kind: "weblink", data } });
  expect(meta?.kind).toBe("weblink");
  if (meta?.kind !== "weblink") return;
  await act(async () => root.render(<WebLinkNode data={meta.data} />));
}

const play = () => container.querySelector<HTMLButtonElement>("button");
const frames = () => [...container.querySelectorAll("iframe")];

/** The item an agent or person would send to `POST .../ops`; the route applies this schema to every writer. */
function opsBatch(url: string) {
  return {
    clientBatchId: "b1",
    ops: [{ op: "add", item: { itemType: "node", key: "w1", kind: "weblink", x: 0, y: 0, width: 400, height: 300, zIndex: 2, color: "slate", title: "", content: "", data: { url } } }],
  };
}

describe("web link card on raw stored nodes (PAR-14389 E D1b)", () => {
  it.each(FORMS)("%s: no iframe, or exactly the nocookie embed of the 11-character id", async (url) => {
    const stored = planningCanvasOpBatchSchema.safeParse(opsBatch(url)).success;
    // Render what the route stored; render refused forms too, as a row an older build might have written.
    await renderRaw({ url });
    expect(frames()).toHaveLength(0); // nothing loads before the click
    const button = container.querySelector<HTMLButtonElement>("button");
    if (button) await act(async () => button.click());
    for (const frame of frames()) {
      expect(frame.getAttribute("src")).toBe(NOCOOKIE);
      expect(frame.getAttribute("src")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/);
    }
    if (frames().length) expect(stored).toBe(true);
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href")).toMatch(/^https:\/\//);
  });

  it("refused forms are refused by the ops schema and draw no link and no frame", async () => {
    for (const url of [`http://www.youtube.com/watch?v=${ID}`, "javascript:alert(1)", `https://user@www.youtube.com/watch?v=${ID}`]) {
      expect(planningCanvasOpBatchSchema.safeParse(opsBatch(url)).success, url).toBe(false);
      await renderRaw({ url });
      expect(container.querySelector("a, iframe, button")).toBeNull();
      expect(container.textContent).toContain("This link can't be shown");
    }
  });

  it("the player frame carries the sandbox, allow, referrer and lazy attributes", async () => {
    await renderRaw({ url: `https://youtu.be/${ID}` });
    await act(async () => play()!.click());
    const [frame] = frames();
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation allow-popups");
    expect(frame!.getAttribute("allow")).toBe("encrypted-media; picture-in-picture; fullscreen");
    expect(frame!.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(frame!.getAttribute("loading")).toBe("lazy");
  });

  it("removes the player when the card leaves the view", async () => {
    let report: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: typeof report) { report = cb; }
      observe() {}
      disconnect() {}
    });
    await renderRaw({ url: `https://www.youtube.com/watch?v=${ID}` });
    await act(async () => play()!.click());
    expect(frames()).toHaveLength(1);
    await act(async () => report!([{ isIntersecting: true }]));
    expect(frames()).toHaveLength(1);
    await act(async () => report!([{ isIntersecting: false }]));
    expect(frames()).toHaveLength(0);
    expect(play()?.textContent).toContain("Play video");
  });

  it("shows the host of url even when the preview names another site, and preview HTML as text", async () => {
    await renderRaw({
      url: "https://evil.test/login",
      preview: { title: "<b>accounts.google.com</b> Sign in", description: "<img src=x onerror=alert(1)>", siteName: "Google", fetchedAt: "2026-11-26T00:00:00Z" },
    });
    expect(container.querySelector("[data-weblink-host]")?.getAttribute("data-weblink-host")).toBe("evil.test");
    expect(container.querySelector("[data-weblink-host] span")?.textContent).toBe("evil.test");
    expect(container.textContent).toContain("<b>accounts.google.com</b> Sign in");
    expect(container.textContent).not.toContain("Google"); // siteName is never shown as the site
    expect(container.querySelector("b, img")).toBeNull();
    const open = container.querySelector("a")!;
    expect(open.getAttribute("href")).toBe("https://evil.test/login");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    expect(frames()).toHaveLength(0);
    expect(container.querySelector("button")).toBeNull();
  });

  it("youTubeEmbedSrc builds only the nocookie embed", () => {
    expect(youTubeEmbedSrc(`https://www.youtube.com/watch?v=${ID}&list=x`)).toBe(NOCOOKIE);
    expect(youTubeEmbedSrc(`https://evil.test/watch?v=${ID}`)).toBeNull();
  });
});
