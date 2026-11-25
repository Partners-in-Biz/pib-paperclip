/**
 * PAR-8799 (plan PAR-8787 r3, T2): the preview service's loopback /render endpoint and the review page's one kept-text
 * figure. Handler tests inject a fake Chromium child; the egress test runs real Chromium through the real proxy.
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy } from "../ops/preview-server/egress.mjs";
import { PREVIEW_RENDER_URL } from "../src/service/preview-links.js";
import { SOURCE_BASIS_NOTICE as PLUGIN_NOTICE } from "../src/service/preview.js";
import { createRenderService, keptTextFigure, RENDER_PORT, SOURCE_BASIS_NOTICE } from "../ops/preview-server/render.mjs";
import { findChrome, isPublicAddress, makeProfile } from "../ops/preview-server/sweep.mjs";

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(handler: http.RequestListener, host = "127.0.0.1"): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler);
  return new Promise((done) =>
    server.listen(0, host, () => {
      closers.push(() => new Promise((ok) => server.close(ok)));
      done({ port: (server.address() as { port: number }).port, server });
    }),
  );
}

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
}

function fakeService(options: { timeoutMs?: number; maxBytes?: number } = {}) {
  const children: FakeChild[] = [];
  const spawned: string[][] = [];
  const killed: FakeChild[] = [];
  const events: string[] = [];
  const svc = createRenderService({
    proxyPort: 5555,
    chrome: async () => "/fake/chrome",
    withChromium: async (run) => {
      events.push("profile");
      try {
        return await run("/tmp/pib-preview-profiles/p-abcdef");
      } finally {
        events.push("cleanup");
      }
    },
    checkUrl: async (url) => {
      if (url.includes("127.0.0.1")) throw new Error("refused: non-public");
      return { url };
    },
    spawn: (_bin: string, args: string[]) => {
      const child = new FakeChild();
      children.push(child);
      spawned.push(args);
      return child;
    },
    kill: (child: FakeChild) => {
      killed.push(child);
      events.push("kill");
      // A killed process closes with a signal, as the real one does.
      setImmediate(() => {
        events.push("exit");
        child.emit("close", null, "SIGKILL");
      });
    },
    ...options,
  });
  return { svc, children, spawned, killed, events };
}

async function post(port: number, body: string) {
  const res = await fetch(`http://127.0.0.1:${port}/render`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: res.status, body: (await res.json()) as { html?: string; error?: string } };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((ok) => setTimeout(ok, 5));
};

describe("/render handler", () => {
  it("is on the constant loopback port 3033, the one create-preview calls, and not the approval service's 3032", () => {
    expect(RENDER_PORT).toBe(3033);
    expect(PREVIEW_RENDER_URL).toBe(`http://127.0.0.1:${RENDER_PORT}/render`);
    const approval = readFileSync(join(__dirname, "../../plugin-social/ops/approval-server/server.mjs"), "utf8");
    expect(approval).toContain("PORT ?? 3032");
    const server = readFileSync(join(__dirname, "../ops/preview-server/server.mjs"), "utf8");
    expect(server).toMatch(/renderServer\.listen\(RENDER_PORT, "127\.0\.0\.1"/);
    expect(server).not.toMatch(/RENDER_PORT\s*=|process\.env\.RENDER/);
  });

  it("answers 200 {html} with Chromium's dump, run through the proxy flags", async () => {
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    const pending = post(port, JSON.stringify({ url: "https://huntandgun.co.za/about-us/" }));
    await until(() => f.children.length === 1);
    f.children[0]!.stdout.write("<html><body>hi</body></html>");
    f.children[0]!.emit("close", 0, null);
    expect(await pending).toEqual({ status: 200, body: { html: "<html><body>hi</body></html>" } });
    expect(f.spawned[0]).toContain("--proxy-server=http://127.0.0.1:5555");
    expect(f.spawned[0]!.at(-1)).toBe("https://huntandgun.co.za/about-us/");
    expect(f.events).toEqual(["profile", "cleanup"]);
  });

  it("refuses a URL with 400 and never starts Chromium", async () => {
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    const res = await post(port, JSON.stringify({ url: "http://127.0.0.1:3031/health" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refused/);
    expect((await post(port, "not json")).status).toBe(400);
    expect((await post(port, JSON.stringify({ url: 7 }))).status).toBe(400);
    expect(f.children).toHaveLength(0);
    expect(f.events).toEqual([]);
  });

  it("answers 503 at once when a render is running, without a second Chromium", async () => {
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    const first = post(port, JSON.stringify({ url: "https://a.example/" }));
    await until(() => f.children.length === 1);
    const second = await post(port, JSON.stringify({ url: "https://b.example/" }));
    expect(second.status).toBe(503);
    expect(f.children).toHaveLength(1);
    f.children[0]!.emit("close", 0, null);
    expect((await first).status).toBe(200);
    // The slot is free again.
    const third = post(port, JSON.stringify({ url: "https://c.example/" }));
    await until(() => f.children.length === 2);
    f.children[1]!.emit("close", 0, null);
    expect((await third).status).toBe(200);
  });

  it("kills Chromium and answers 504 on timeout; the profile goes only after it exited", async () => {
    const f = fakeService({ timeoutMs: 50 });
    const { port } = await listen(f.svc.handle);
    const res = await post(port, JSON.stringify({ url: "https://slow.example/" }));
    expect(res.status).toBe(504);
    expect(f.killed).toEqual([f.children[0]]);
    await until(() => f.events.includes("cleanup"));
    expect(f.events).toEqual(["profile", "kill", "exit", "cleanup"]);
    expect(f.svc.isBusy()).toBe(false);
  });

  it("kills Chromium and answers 413 when its output passes the cap", async () => {
    const f = fakeService({ maxBytes: 1024 });
    const { port } = await listen(f.svc.handle);
    const pending = post(port, JSON.stringify({ url: "https://big.example/" }));
    await until(() => f.children.length === 1);
    f.children[0]!.stdout.write("x".repeat(1025));
    expect((await pending).status).toBe(413);
    expect(f.killed).toHaveLength(1);
  });

  it("has a 10 MiB output cap and a 14 s timeout by default; a request body over 8 KiB is 413", async () => {
    const src = readFileSync(join(__dirname, "../ops/preview-server/render.mjs"), "utf8");
    expect(src).toMatch(/RENDER_MAX_BYTES = 10 \* 1024 \* 1024/);
    expect(src).toMatch(/RENDER_TIMEOUT_MS = 14_000/);
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    expect((await post(port, JSON.stringify({ url: `https://a.example/${"x".repeat(9000)}` }))).status).toBe(413);
    expect(f.children).toHaveLength(0);
  });

  it("answers 500 when Chromium fails and kills it when the caller goes away", async () => {
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    const failing = post(port, JSON.stringify({ url: "https://broken.example/" }));
    await until(() => f.children.length === 1);
    f.children[0]!.emit("close", 1, null);
    expect((await failing).status).toBe(500);

    const ctl = new AbortController();
    const aborted = fetch(`http://127.0.0.1:${port}/render`, { method: "POST", body: JSON.stringify({ url: "https://gone.example/" }), signal: ctl.signal }).catch(() => "aborted");
    await until(() => f.children.length === 2);
    ctl.abort();
    expect(await aborted).toBe("aborted");
    await until(() => f.killed.length === 1);
    expect(f.killed).toEqual([f.children[1]]);
  });

  it("only knows POST /render", async () => {
    const f = fakeService();
    const { port } = await listen(f.svc.handle);
    expect((await fetch(`http://127.0.0.1:${port}/render`)).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/p/x`, { method: "POST" })).status).toBe(404);
  });
});

describe("/render through the egress proxy (real Chromium)", async () => {
  const chrome = await findChrome(process.env.PLAYWRIGHT_BROWSERS_DIR ?? join(homedir(), ".cache/ms-playwright"), process.env.CHROME_PATH).catch(() => null);
  if (!chrome) console.warn("SKIPPED: no Chromium binary found (set CHROME_PATH or install Playwright Chromium); the real egress render test did not run.");

  it.skipIf(!chrome)("renders a public page, and the dump has nothing from the iframe, img or fetch() to private addresses", { timeout: 40_000 }, async () => {
    // A "private" server holding secrets: anything reaching it would show SECRET in the dump.
    let secretHits = 0;
    const secret = await listen((_req, res) => {
      secretHits += 1;
      res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" }).end("SECRET-LOOPBACK");
    });
    const s = `http://127.0.0.1:${secret.port}`;
    const page = `<!doctype html><html><body><h1>PUBLIC-PAGE</h1>
<iframe src="${s}/iframe"></iframe><img src="${s}/img.png">
<script>
Promise.allSettled(["${s}/fetch", "http://127.0.0.1:3031/health", "http://169.254.169.254/latest/meta-data/", "http://localhost:${secret.port}/fetch"].map((u) => fetch(u).then((r) => r.text())))
  .then((all) => { for (const a of all) if (a.status === "fulfilled") document.body.append("GO" + "T:" + a.value); document.body.append("SCRIPT" + "-DONE"); });
</script></body></html>`;
    // The test upstream sits on 127.0.0.2; only it is "public" for this proxy.
    const upstream = await listen((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page), "127.0.0.2");
    const lines: string[] = [];
    const egress = await startEgressProxy({
      resolve: async (host) => (host === "upstream.test" ? ["127.0.0.2"] : host === "localhost" ? ["127.0.0.1"] : []),
      isPublic: (ip) => ip === "127.0.0.2" || isPublicAddress(ip),
      ports: [80, 443, upstream.port, secret.port, 3031],
      log: (line) => lines.push(line),
    });
    closers.push(() => egress.close());
    // Chromium aborts when its singleton socket path is over ~107 bytes, so the profile root must be short (/tmp, as on the VPS).
    const root = mkdtempSync(join(tmpdir().length < 40 ? tmpdir() : "/tmp", "seo-render-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const svc = createRenderService({
      proxyPort: egress.port,
      chrome: async () => chrome!,
      withChromium: async (run) => {
        const profile = await makeProfile(root);
        try {
          return await run(profile.dir);
        } finally {
          await profile.cleanup();
        }
      },
      checkUrl: async (url) => ({ url }),
      timeoutMs: 30_000,
    });
    closers.push(() => svc.stop());
    const { port } = await listen(svc.handle);
    const res = await post(port, JSON.stringify({ url: `http://upstream.test:${upstream.port}/page` }));
    expect(res.status, res.body.error).toBe(200);
    const html = res.body.html!;
    expect(html).toContain("PUBLIC-PAGE");
    expect(html).toContain("</script>SCRIPT-DONE"); // the page's script ran
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("GOT:");
    expect(secretHits).toBe(0);
    const log = lines.join("\n");
    expect(log).toMatch(/127\.0\.0\.1:3031.*refused/);
    expect(log).toMatch(/169\.254\.169\.254.*refused/);
  });
});

describe("review page: one kept-text figure", () => {
  const rendered = { liveWords: 1246, previewWords: 1290, keptPct: 100, addedWords: 44, removedWords: 0, at: "2026-11-09T12:00:00Z" };
  const figures = (html: string) => html.match(/\d+%/g) ?? [];

  it("shows only stats.rendered, without the notice on rendered basis", () => {
    const html = keptTextFigure({ basis: "rendered", rendered });
    expect(figures(html)).toEqual(["100%"]);
    expect(html).not.toContain(SOURCE_BASIS_NOTICE);
  });

  it("adds the notice on source basis (or no basis) and never shows the source figures", () => {
    for (const stats of [{ basis: "source", keptPct: 93, liveWords: 1200, rendered }, { keptPct: 93, rendered }]) {
      const html = keptTextFigure(stats);
      expect(figures(html)).toEqual(["100%"]);
      expect(html).toContain("Made from the page source: header and scripted parts may differ.");
      expect(html).toContain(PLUGIN_NOTICE);
      expect(html).not.toContain("93");
    }
    expect(keptTextFigure({ basis: "source", keptPct: 93 })).toMatch(/could not be made/);
  });

  it("server.mjs no longer has the source table and recomputes only rows without a rendered figure", () => {
    const server = readFileSync(join(__dirname, "../ops/preview-server/server.mjs"), "utf8");
    expect(server).not.toContain("Figures from the page source");
    expect(server).toContain("${keptTextFigure(st)}");
    expect(server).toContain("if (!stats.rendered || !(stats.rendered.liveWords > 0)) {");
  });
});
