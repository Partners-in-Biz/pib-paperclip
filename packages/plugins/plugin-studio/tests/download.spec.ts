/** downloadOutput: a provider's result URL is untrusted. One request, to the checked address, no redirects, bounded size. */
import { describe, expect, it, vi } from "vitest";
import { downloadOutput, pinnedLookup, type DownloadResponse, type DownloadTransport, type PinnedAddress } from "../src/generation.js";

const PUBLIC: PinnedAddress = { address: "93.184.216.34", family: 4 };

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield part;
}

function response(status: number, headers: Record<string, string>, body: AsyncIterable<Uint8Array> = chunks()): DownloadResponse & { closed: boolean } {
  const res = {
    status,
    closed: false,
    header: (name: string) => headers[name.toLowerCase()] ?? null,
    body,
    close: () => {
      res.closed = true;
    },
  };
  return res;
}

function transport(answers: Record<string, PinnedAddress[]>, reply: (url: URL) => DownloadResponse) {
  const resolve = vi.fn(async (host: string) => answers[host] ?? []);
  const get = vi.fn(async (url: URL, _pinned: PinnedAddress, _signal: AbortSignal) => reply(url));
  return { resolve, get } satisfies DownloadTransport;
}

describe("downloadOutput", () => {
  it("does not follow a redirect to another origin, and makes exactly one request", async () => {
    const redirect = response(302, { location: "https://169.254.169.254/latest/meta-data/" });
    const t = transport({ "cdn.example.com": [PUBLIC], "169.254.169.254": [{ address: "169.254.169.254", family: 4 }] }, () => redirect);

    await expect(downloadOutput("https://cdn.example.com/out.png", { transport: t })).rejects.toThrow(/redirects \(HTTP 302\)/);
    expect(t.get).toHaveBeenCalledTimes(1);
    expect(t.get.mock.calls[0]![0].href).toBe("https://cdn.example.com/out.png");
    expect(t.resolve).toHaveBeenCalledTimes(1);
    expect(t.resolve).toHaveBeenCalledWith("cdn.example.com");
    expect(redirect.closed).toBe(true);
  });

  it("refuses every 3xx, not just 302", async () => {
    for (const status of [301, 303, 307, 308]) {
      const t = transport({ "cdn.example.com": [PUBLIC] }, () => response(status, { location: "https://evil.example/" }));
      await expect(downloadOutput("https://cdn.example.com/a", { transport: t })).rejects.toThrow(/redirects/);
      expect(t.get).toHaveBeenCalledTimes(1);
    }
  });

  it("connects to the address it checked", async () => {
    const t = transport({ "cdn.example.com": [PUBLIC] }, () => response(200, {}, chunks(new Uint8Array([1, 2, 3]))));
    const bytes = await downloadOutput("https://cdn.example.com/a", { transport: t });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(t.get.mock.calls[0]![1]).toEqual(PUBLIC);
  });

  it("refuses http, private and unresolvable hosts without making a request", async () => {
    const t = transport(
      { "internal.example": [PUBLIC, { address: "10.0.0.5", family: 4 }], "v6.example": [{ address: "::ffff:127.0.0.1", family: 6 }], "127.0.0.1": [{ address: "127.0.0.1", family: 4 }] },
      () => response(200, {}),
    );
    await expect(downloadOutput("http://cdn.example.com/a", { transport: t })).rejects.toThrow(/https/);
    await expect(downloadOutput("https://internal.example/a", { transport: t })).rejects.toThrow(/private/);
    await expect(downloadOutput("https://v6.example/a", { transport: t })).rejects.toThrow(/private/);
    await expect(downloadOutput("https://127.0.0.1/a", { transport: t })).rejects.toThrow(/private/);
    await expect(downloadOutput("https://nowhere.example/a", { transport: t })).rejects.toThrow(/private/);
    expect(t.get).not.toHaveBeenCalled();
  });

  it("stops reading once a body with no content-length passes the limit", async () => {
    let read = 0;
    async function* endless(): AsyncIterable<Uint8Array> {
      for (;;) {
        read += 1;
        yield new Uint8Array(4);
      }
    }
    const res = response(200, {}, endless());
    const t = transport({ "cdn.example.com": [PUBLIC] }, () => res);
    await expect(downloadOutput("https://cdn.example.com/a", { transport: t, maxBytes: 10 })).rejects.toThrow(/larger than Studio stores/);
    expect(read).toBe(3);
    expect(res.closed).toBe(true);
  });

  it("refuses a declared content-length over the limit before reading", async () => {
    let read = 0;
    async function* body(): AsyncIterable<Uint8Array> {
      read += 1;
      yield new Uint8Array(1);
    }
    const t = transport({ "cdn.example.com": [PUBLIC] }, () => response(200, { "content-length": "11" }, body()));
    await expect(downloadOutput("https://cdn.example.com/a", { transport: t, maxBytes: 10 })).rejects.toThrow(/larger/);
    expect(read).toBe(0);
  });

  it("reports a non-2xx answer", async () => {
    const t = transport({ "cdn.example.com": [PUBLIC] }, () => response(404, {}));
    await expect(downloadOutput("https://cdn.example.com/a", { transport: t })).rejects.toThrow(/HTTP 404/);
  });
});

describe("pinnedLookup", () => {
  it("answers with the checked address whatever host is asked, in both callback shapes", () => {
    const pin = pinnedLookup(PUBLIC);
    const single = vi.fn();
    const all = vi.fn();
    pin("rebound.example", {}, single);
    pin("rebound.example", { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, PUBLIC.address, PUBLIC.family);
    expect(all).toHaveBeenCalledWith(null, [PUBLIC]);
  });
});
