import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { captureMismatch, fetchLive, guardShot, isBlankPng, proposalState, shotUntilPainted, titleOf } from "../ops/preview-server/capture.mjs";

const page = (t: string) => `<html><head><title>${t}</title></head><body>x</body></html>`;

describe("captureMismatch (PAR-9042)", () => {
  it("accepts the right host and title", () => {
    expect(captureMismatch({ status: 200, url: "https://www.agristudies.co.za/p/", html: page("A") }, { host: "agristudies.co.za" })).toBeNull();
    expect(captureMismatch({ status: 200, url: "http://127.0.0.1:3031/p/t", html: page("A  B") }, { host: "127.0.0.1", title: page("A B") })).toBeNull();
  });
  it("refuses an error page, another host and another title", () => {
    expect(captureMismatch({ status: 410, url: "http://127.0.0.1:3031/p/t", html: page("x") }, { host: "127.0.0.1" })).toMatch(/HTTP 410/);
    expect(captureMismatch({ status: 200, url: "https://other.example/", html: page("A") }, { host: "agristudies.co.za" })).toMatch(/host other\.example/);
    expect(captureMismatch({ status: 200, url: "http://127.0.0.1/", html: page("Expired") }, { host: "127.0.0.1", title: page("Hydroponics") })).toMatch(/title/);
  });
  it("reads titles", () => expect(titleOf(page(" Hi \n there "))).toBe("Hi there"));
});

describe("proposalState (PAR-9042)", () => {
  const row = { status: "pending", review_key: "k", review_status: "passed", expired: false, approved_live: false };
  it("an expired link still shows the proposal to the review key", () => expect(proposalState({ ...row, expired: true }, "k")).toBe("staff"));
  it("an expired link without the key, or with a wrong key, is expired", () => {
    expect(proposalState({ ...row, expired: true }, "")).toBe("expired");
    expect(proposalState({ ...row, expired: true }, "wrong")).toBe("expired");
  });
  it("cancelled and declined win over the review key", () => {
    expect(proposalState({ ...row, status: "cancelled", expired: true }, "k")).toBe("cancelled");
    expect(proposalState({ ...row, status: "declined" }, "k")).toBe("declined");
  });
  it("keeps the client flow", () => {
    expect(proposalState({ ...row, expired: true, approved_live: true }, "")).toBe("approved");
    expect(proposalState({ ...row, review_status: "pending" }, "")).toBe("hold");
    expect(proposalState(row, "")).toBe("serve");
  });
});

const res = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });
const okCheck = async () => ({});

describe("fetchLive and guardShot (PAR-9042)", () => {
  it("refuses a redirect to another site and does not fetch it", async () => {
    const f = vi.fn(async () => res(302, "", { location: "http://127.0.0.1:3031/secret" }));
    await expect(fetchLive("https://agristudies.co.za/x", { fetchImpl: f as never, check: okCheck as never })).rejects.toThrow(/another site/);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("runs every hop through the egress check and stops when it refuses", async () => {
    const check = vi.fn(async (u: string) => { if (u.includes("internal")) throw new Error("refused: non-public"); return {}; });
    const f = vi.fn(async () => res(200, "<title>x</title>"));
    await expect(fetchLive("https://internal.agristudies.co.za/", { fetchImpl: f as never, check: check as never })).rejects.toThrow(/refused/);
    expect(f).not.toHaveBeenCalled();
  });
  it("caps redirects and the body", async () => {
    const loop = vi.fn(async () => res(301, "", { location: "/again" }));
    await expect(fetchLive("https://agristudies.co.za/", { fetchImpl: loop as never, check: okCheck as never, maxHops: 2 })).rejects.toThrow(/too many/);
    expect(loop).toHaveBeenCalledTimes(3);
    const big = await fetchLive("https://agristudies.co.za/", { fetchImpl: (async () => res(200, "a".repeat(5000))) as never, check: okCheck as never, maxBytes: 100 });
    expect(big.html.length).toBe(100);
  });
  it("live shot ignores a WAF 403 but refuses a public-site redirect", async () => {
    await expect(guardShot({ which: "live", liveUrl: "https://agristudies.co.za/", proposalUrl: "", proposalHtml: "" }, { fetchImpl: (async () => res(403)) as never, check: okCheck as never })).resolves.toBeUndefined();
  });
  it("proposal shot throws on a non-2xx and on a title mismatch, so /shot answers 502", async () => {
    const args = { which: "proposed", mobile: true, liveUrl: "", proposalUrl: "http://127.0.0.1:3031/p/t?key=k", proposalHtml: page("Hydroponics") };
    await expect(guardShot(args, { fetchImpl: (async () => res(410, page("expired"))) as never })).rejects.toThrow(/HTTP 410/);
    await expect(guardShot(args, { fetchImpl: (async () => res(200, page("This preview has expired"))) as never })).rejects.toThrow(/title/);
    await expect(guardShot(args, { fetchImpl: (async () => res(200, page("Hydroponics"))) as never })).resolves.toBeUndefined();
  });
});

/** An 8-bit RGB PNG, each row stored with `filter` (Sub, Up or Paeth on a flat image still decode to the same pixels). */
function png(width: number, height: number, pixel: (x: number, y: number) => number[], filter = 0): Buffer {
  const rows: number[] = [];
  let prev: number[] = new Array(width * 3).fill(0);
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(...pixel(x, y));
    const enc = row.map((v, i) => {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter];
      return (v - pred) & 0xff;
    });
    rows.push(filter, ...enc);
    prev = row;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("isBlankPng (PAR-12454)", () => {
  const white = () => [255, 255, 255];
  it("finds a one-colour shot blank, whatever the row filter", () => {
    for (const filter of [0, 1, 2, 3, 4]) expect(isBlankPng(png(40, 30, white, filter))).toBe(true);
    expect(isBlankPng(png(40, 30, () => [20, 40, 60], 4))).toBe(true);
  });
  it("finds one dark pixel or a gradient not blank, however small the file", () => {
    const dot = png(40, 30, (x, y) => (x === 39 && y === 29 ? [0, 0, 0] : [255, 255, 255]), 1);
    expect(dot.length).toBeLessThan(1_000);
    expect(isBlankPng(dot)).toBe(false);
    expect(isBlankPng(png(40, 30, (x) => [x, x, x], 4))).toBe(false);
  });
  it("never refuses what it cannot read", () => {
    expect(isBlankPng(Buffer.from("not a png at all, just some text bytes"))).toBe(false);
    expect(isBlankPng(Buffer.alloc(0))).toBe(false);
    const grey = png(4, 4, white);
    grey[25] = 0; // colour type 0 (greyscale): not what Chromium writes
    expect(isBlankPng(grey)).toBe(false);
  });
});

describe("shotUntilPainted (PAR-12454)", () => {
  const blank = png(8, 8, () => [255, 255, 255]);
  const real = png(8, 8, (x, y) => [x * 30, y * 30, 0]);
  it("retakes a blank shot and serves the first painted one", async () => {
    const shots = [blank, real];
    const take = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const read = vi.fn(async () => shots[take.mock.calls.length - 1]);
    await expect(shotUntilPainted({ take, read, remove, label: "live" })).resolves.toBe(real);
    expect(take).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("gives up after three blank shots, deletes the file and throws so /shot answers 502", async () => {
    const take = vi.fn(async () => undefined);
    const remove = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    await expect(shotUntilPainted({ take, read: async () => blank, remove, label: "live-mobile" })).rejects.toThrow(
      "shot for live-mobile came out blank after 3 tries",
    );
    expect(take).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
  });
});
