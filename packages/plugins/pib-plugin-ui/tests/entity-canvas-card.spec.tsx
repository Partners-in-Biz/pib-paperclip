// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardBatcher, type CardsResolve } from "../src/entity-card-batcher.js";
import { ENTITY_CARD_TEXT, EntityCanvasCard } from "../src/entity-canvas-card.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const summary = (id: string, extra: Record<string, unknown> = {}) => ({ type: "card-company", id, title: `Company ${id}`, href: `/crm?client=company:${id}`, ...extra });

async function draw(resolve: CardsResolve, id = "c1") {
  const batcher = createCardBatcher(resolve);
  act(() => root.render(<EntityCanvasCard batcher={batcher} type="card-company" id={id} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
  return batcher;
}
const state = () => container.querySelector("[data-card-state]")?.getAttribute("data-card-state");

describe("refusal mapping: every shape draws the same No access card", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["hidden item", async () => ({ cards: [{ type: "card-company", id: "c1", hidden: true }] })],
    ["core 403 MEMBER_RESTRICTED", async () => { throw { code: "MEMBER_RESTRICTED", message: "Restricted", status: 403 }; }],
    ["core 403 CANVAS_CARDS_PERSON_ONLY", async () => { throw { code: "UNKNOWN", message: "CANVAS_CARDS_PERSON_ONLY" }; }],
    ["kit refusal", async () => ({ ok: false, refused: true, code: "PERMISSION_DENIED", message: "No" })],
    ["Social rule", async () => ({ ok: false, error: { code: "SOCIAL_RULE", message: "No" } })],
  ];
  for (const [name, resolve] of cases) {
    it(name, async () => {
      await draw(vi.fn(resolve));
      expect(state()).toBe("hidden");
      expect(container.textContent).toContain(ENTITY_CARD_TEXT.noAccess);
      expect(container.querySelector("a")).toBeNull();
    });
  }
});

describe("failures", () => {
  it("draws Couldn't load for a 5xx and a network failure, and retry loads again", async () => {
    for (const error of [{ status: 502, message: "Bad gateway" }, new TypeError("Failed to fetch")]) {
      const resolve = vi.fn<CardsResolve>().mockRejectedValueOnce(error).mockResolvedValue({ cards: [summary("c1")] });
      await draw(resolve);
      expect(state()).toBe("error");
      expect(container.textContent).toContain(ENTITY_CARD_TEXT.loadFailed);
      act(() => container.querySelector("button")!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
      expect(state()).toBe("card");
      expect(resolve).toHaveBeenCalledTimes(2);
    }
  });
});

describe("batching", () => {
  const ask = async (n: number) => {
    const resolve = vi.fn<CardsResolve>(async ({ items }) => ({ cards: items.map((i) => summary(i.id)) }));
    const batcher = createCardBatcher(resolve);
    const loads = Array.from({ length: n }, (_, i) => batcher.load("card-company", `id${i}`));
    await vi.advanceTimersByTimeAsync(40);
    await Promise.all(loads);
    return { resolve, batcher };
  };
  it("30 cards make one call", async () => {
    const { resolve } = await ask(30);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0].items).toHaveLength(30);
  });
  it("101 ids make two calls", async () => {
    const { resolve } = await ask(101);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls.map((c) => c[0].items.length).sort()).toEqual([1, 100]);
  });
  it("keeps answers while the board is open", async () => {
    const { resolve, batcher } = await ask(2);
    await batcher.load("card-company", "id0");
    await vi.advanceTimersByTimeAsync(100);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe("text only", () => {
  it("draws HTML in a title, meta and subtitle as text; drops an absolute href", async () => {
    const html = '<img src=x onerror="alert(1)"><b>bold</b>';
    await draw(async () => ({ cards: [summary("c1", { title: html, subtitle: html, status: "Open", meta: [{ label: "A", value: html }], href: "//evil.example/x" })] }));
    expect(state()).toBe("card");
    expect(container.querySelector("img, b")).toBeNull();
    expect(container.textContent).toContain(html);
    expect(container.querySelector("a")).toBeNull();
  });
  it("draws Open with the href, at most four meta rows", async () => {
    const meta = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));
    await draw(async () => ({ cards: [summary("c1", { meta })] }));
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/crm?client=company:c1");
    expect(container.querySelectorAll("dt")).toHaveLength(4);
  });
  for (const href of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example"]) {
    it(`draws no link for a control character in href ${JSON.stringify(href)}`, async () => {
      await draw(async () => ({ cards: [summary("c1", { href })] }));
      expect(state()).toBe("card");
      expect(container.querySelector("a")).toBeNull();
    });
  }
});
