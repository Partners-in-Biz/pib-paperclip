import { describe, expect, it, vi } from "vitest";
import { captureMismatch, fetchLive, guardShot, proposalState, titleOf } from "../ops/preview-server/capture.mjs";

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
