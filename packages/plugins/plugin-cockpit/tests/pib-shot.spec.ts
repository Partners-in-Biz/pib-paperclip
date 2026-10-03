/**
 * pib-shot, the headless screenshot command for developer and tester agents
 * (Q5-5). The browser is faked: what is tested is what the command decides, its
 * argument handling first (a wrong call must be refused before any browser starts),
 * then which browser it picks, what it tells Chrome, and when a picture is no
 * evidence. The script itself is run for real against Chrome by hand (README).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type * as ShotModule from "../scripts/pib-shot.cjs";

const shot = createRequire(import.meta.url)("../scripts/pib-shot.cjs") as typeof ShotModule;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const usage = (argv: string[]): string => {
  try {
    shot.parseArgs(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(shot.UsageError);
    return (error as Error).message;
  }
  return "";
};

describe("the arguments", () => {
  it("take a page and fill in the defaults", () => {
    expect(shot.parseArgs(["https://staging.example.co.za/pricing"])).toEqual({ url: "https://staging.example.co.za/pricing", out: null, viewport: "desktop", wait: 3000, timeout: 45, expect: [], json: false, help: false });
  });

  it("read every option, spaced or with =, and keep each --expect", () => {
    const opts = shot.parseArgs(["http://localhost:3000/", "--out", "/tmp/a.png", "--viewport=mobile", "--wait", "1500", "--timeout=20", "--expect", "Pricing", "--expect=Sign in", "--json"]);
    expect(opts).toMatchObject({ out: "/tmp/a.png", viewport: "mobile", wait: 1500, timeout: 20, expect: ["Pricing", "Sign in"], json: true });
  });

  it("accept the page after the options too", () => {
    expect(shot.parseArgs(["--viewport", "tablet", "http://localhost:3000/"]).url).toBe("http://localhost:3000/");
  });

  it("ask for help without a page", () => {
    expect(shot.parseArgs(["--help"]).help).toBe(true);
    expect(shot.parseArgs(["-h"]).help).toBe(true);
  });

  it("refuse a call with no page, two pages, an unknown option and an option with no value", () => {
    expect(usage([])).toContain("Give the page");
    expect(usage(["http://a.test/", "http://b.test/"])).toContain("Only one page");
    expect(usage(["http://a.test/", "--fullpage"])).toContain("Unknown option --fullpage");
    expect(usage(["http://a.test/", "--out"])).toContain("--out needs a value");
    expect(usage(["http://a.test/", "--out", "--json"])).toContain("--out needs a value");
  });

  it("refuse an address that is not a page, or carries a login", () => {
    expect(usage(["not a url"])).toContain("is not an address");
    expect(usage(["javascript:alert(1)"])).toContain("Only http, https and file");
    expect(usage(["data:text/html,<h1>x</h1>"])).toContain("Only http, https and file");
    expect(usage(["ftp://x.test/"])).toContain("Only http, https and file");
    expect(usage(["https://user:secret@x.test/"])).toContain("Do not put a login");
    expect(shot.parseArgs(["file:///tmp/page.html"]).url).toBe("file:///tmp/page.html");
  });

  it("take only a .png for --out: the command replaces what is at that path, so a name that is not a picture is refused before anything runs", () => {
    for (const bad of ["/tmp/x", "src/app.ts", "/tmp/shot.jpg", "notes.md", "/tmp/o.png.bak", "/tmp/"]) expect(usage(["http://a.test/", "--out", bad]), bad).toContain("--out must be a .png file");
    for (const good of ["/tmp/o.png", "shots/Mobile.PNG", "./a.b.png"]) expect(usage(["http://a.test/", "--out", good]), good).toBe("");
    expect(usage(["http://a.test/", "--out=/home/paperclip/.bashrc"])).toContain("--out must be a .png file");
    // Without --out the default name is a .png: nothing to refuse.
    expect(usage(["http://a.test/"])).toBe("");
  });

  it("refuse numbers that are not numbers or are out of range", () => {
    expect(usage(["http://a.test/", "--wait", "soon"])).toContain("--wait must be a number");
    expect(usage(["http://a.test/", "--wait", "120000"])).toContain("at most 60000");
    expect(usage(["http://a.test/", "--timeout", "2"])).toContain("from 5 to 300");
    expect(usage(["http://a.test/", "--timeout", "900"])).toContain("from 5 to 300");
  });

  it("know the viewports and refuse others", () => {
    expect(shot.viewportOf("desktop")).toEqual({ name: "desktop", width: 1280, height: 800, mobile: false });
    expect(shot.viewportOf("mobile")).toMatchObject({ width: 390, height: 844, mobile: true });
    expect(shot.viewportOf("tablet")).toMatchObject({ width: 768, height: 1024 });
    expect(shot.viewportOf("1280x2400")).toEqual({ name: "1280x2400", width: 1280, height: 2400, mobile: false });
    expect(shot.viewportOf("375x700").mobile).toBe(true);
    for (const bad of ["phone", "1280", "99999x10", "100x100", "1280x"]) expect(() => shot.viewportOf(bad), bad).toThrow(shot.UsageError);
    expect(usage(["http://a.test/", "--viewport", "phone"])).toContain("--viewport is");
  });
});

describe("where the picture goes and which browser takes it", () => {
  it("names the default file after the host and the viewport, in a folder agents can write", () => {
    const out = shot.defaultOut("https://staging.example.co.za/a?b=1", "mobile", new Date("2026-10-03T12:34:56.789Z"));
    expect(out.endsWith("/pib-shots/staging.example.co.za-mobile-20261003T123456Z.png")).toBe(true);
  });

  it("tries the one named, then the headless shell, then Playwright's Chromium, then the system's", () => {
    const dirs = ["chromium-1100", "chromium_headless_shell-1243", "chromium-1243", "ffmpeg-1011", "chromium_headless_shell-1100"];
    const list = shot.chromeCandidates({ PIB_SHOT_CHROME: "/opt/mine/chrome" }, "linux", "/home/paperclip", () => dirs);
    expect(list[0]).toBe("/opt/mine/chrome");
    expect(list[1]).toBe("/home/paperclip/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell");
    const shellsFirst = list.findIndex((c) => c.includes("chromium-1243/chrome-linux64/chrome"));
    expect(list.slice(1, shellsFirst).every((c) => c.includes("headless_shell"))).toBe(true);
    expect(shellsFirst).toBeLessThan(list.indexOf("/usr/bin/google-chrome-stable"));
    expect(list.indexOf("/home/paperclip/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")).toBeLessThan(list.indexOf("/home/paperclip/.cache/ms-playwright/chromium-1100/chrome-linux64/chrome"));
  });

  it("works with no Playwright cache, and on a Mac", () => {
    const none = shot.chromeCandidates({}, "linux", "/home/x", () => {
      throw new Error("no such directory");
    });
    expect(none).toContain("/usr/bin/google-chrome-stable");
    expect(shot.chromeCandidates({}, "darwin", "/Users/x", () => [])[0]).toContain("Google Chrome.app");
  });

  it("uses the first browser that exists, or none", () => {
    expect(shot.findChrome(["/nope", "/yes", "/also"], (p) => p !== "/nope")).toBe("/yes");
    expect(shot.findChrome(["/nope"], () => false)).toBeNull();
  });

  it("tells the headless shell from full Chrome", () => {
    expect(shot.isHeadlessShell("/x/chrome-headless-shell-linux64/chrome-headless-shell")).toBe(true);
    expect(shot.isHeadlessShell("/x/chrome-linux/headless_shell")).toBe(true);
    expect(shot.isHeadlessShell("/x/chrome-linux64/chrome")).toBe(false);
    expect(shot.isHeadlessShell("/x/chromium_headless_shell-1243/chrome-linux64/chrome")).toBe(false);
  });
});

describe("what Chrome is told", () => {
  const opts = shot.parseArgs(["https://x.test/", "--wait", "2500"]);
  const desktop = shot.viewportOf("desktop");

  it("asks for headless, a window of the viewport's size, the picture and the page", () => {
    const args = shot.buildChromeArgs(opts, "/tmp/o.png", desktop, "/tmp/profile");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--window-size=1280,800");
    expect(args).toContain("--virtual-time-budget=2500");
    expect(args).toContain("--screenshot=/tmp/o.png");
    expect(args).toContain("--user-data-dir=/tmp/profile");
    expect(args[args.length - 1]).toBe("https://x.test/");
    expect(args.some((a) => a.startsWith("--user-agent"))).toBe(false);
  });

  it("the headless shell has no --headless switch, and a phone gets a phone's browser identity", () => {
    const args = shot.buildChromeArgs(opts, "/tmp/o.png", shot.viewportOf("mobile"), "/tmp/p", false, true);
    expect(args.some((a) => a.startsWith("--headless"))).toBe(false);
    expect(args.find((a) => a.startsWith("--user-agent"))).toContain("iPhone");
  });

  it("dumps the page instead of taking a picture for the second pass", () => {
    const args = shot.buildChromeArgs(opts, "/tmp/o.png", desktop, "/tmp/p", true);
    expect(args).toContain("--dump-dom");
    expect(args.some((a) => a.startsWith("--screenshot"))).toBe(false);
  });
});

describe("reading the page", () => {
  it("finds expected text whatever the case or spacing", () => {
    const dom = "<h1>Our   Pricing</h1>\n<p>Sign\n in</p>";
    expect(shot.checkExpected(dom, ["our pricing", "SIGN IN", "Contact us"])).toEqual([
      { text: "our pricing", found: true },
      { text: "SIGN IN", found: true },
      { text: "Contact us", found: false },
    ]);
  });

  it("calls a page that rendered nothing, or the browser's error page, no evidence", () => {
    expect(shot.loadError("<html><head></head><body></body></html>")).toBe("the page rendered nothing");
    expect(shot.loadError("<html><head><title>t</title></head><body>\n</body></html>")).toBe("the page rendered nothing");
    expect(shot.loadError('<div id="main-frame-error"><div>ERR_CONNECTION_REFUSED</div></div>')).toBe("ERR_CONNECTION_REFUSED");
    expect(shot.loadError("<html><body><h1>Hello</h1></body></html>")).toBeNull();
    // A page that is only an image or a canvas is not blank.
    expect(shot.loadError('<html><body><img src="a.png"></body></html>')).toBeNull();
    expect(shot.loadError("<html><body><canvas></canvas></body></html>")).toBeNull();
  });
});

describe("taking the picture", () => {
  const good = "<html><body><h1>Hello canary</h1></body></html>";

  /** A fake disk and browser: the screenshot run writes `size` bytes, the dump run answers `dom`. */
  function world(options: { size?: number; dom?: string; chrome?: string | null; error?: Error } = {}) {
    const files = new Map<string, number>();
    /** The first bytes of a file that is there before the run (a picture unless a test says otherwise). */
    const heads = new Map<string, Buffer>();
    const removed: string[] = [];
    const calls: string[][] = [];
    const fs = {
      mkdirSync: () => undefined,
      mkdtempSync: (prefix: string) => `${prefix}abc`,
      rmSync: (file: string) => {
        removed.push(file);
        files.delete(file);
      },
      statSync: (file: string) => {
        if (!files.has(file)) throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
        return { size: files.get(file)!, isFile: () => !file.endsWith("/dir.png") };
      },
      openSync: (file: string) => file,
      readSync: (file: string, buffer: Buffer) => {
        const head = heads.get(file) ?? PNG;
        head.copy(buffer, 0, 0, Math.min(head.length, buffer.length));
        return Math.min(head.length, buffer.length);
      },
      closeSync: () => undefined,
      readFileSync: () => Buffer.from("png"),
    };
    const run = async (_chrome: string, args: string[]) => {
      calls.push(args);
      const shotArg = args.find((a) => a.startsWith("--screenshot="));
      if (shotArg && options.size) files.set(shotArg.slice("--screenshot=".length), options.size);
      return { error: options.error ?? null, stdout: args.includes("--dump-dom") ? options.dom ?? good : "", stderr: "" };
    };
    return { calls, files, heads, removed, deps: { chrome: options.chrome === undefined ? "/x/chrome-headless-shell" : options.chrome, fs, run, now: () => new Date("2026-10-03T12:00:00Z") } };
  }

  const opts = (...argv: string[]) => shot.parseArgs(["https://x.test/", "--out", "/tmp/o.png", ...argv]);

  it("reports the path, size and a hash as evidence", async () => {
    const w = world({ size: 8000 });
    const done = await shot.shoot(opts(), w.deps as never);
    expect(done.code).toBe(0);
    expect(done.result).toMatchObject({ ok: true, path: "/tmp/o.png", bytes: 8000, viewport: "desktop", url: "https://x.test/" });
    expect(done.result!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says so when there is no browser", async () => {
    const done = await shot.shoot(opts(), world({ chrome: null }).deps as never);
    expect(done.code).toBe(3);
    expect(done.message).toContain("PIB_SHOT_CHROME");
  });

  it("does not call a tiny or missing file a screenshot", async () => {
    expect((await shot.shoot(opts(), world({ size: 300 }).deps as never)).code).toBe(5);
    const timedOut = await shot.shoot(opts(), world({ error: new Error("timed out after 45s") }).deps as never);
    expect(timedOut.code).toBe(5);
    expect(timedOut.message).toContain("timed out");
  });

  it("throws the picture away when the page did not load or is blank", async () => {
    const w = world({ size: 8000, dom: "<html><head></head><body></body></html>" });
    const done = await shot.shoot(opts(), w.deps as never);
    expect(done.code).toBe(5);
    expect(done.message).toContain("no evidence");
    expect((w.deps.fs as { statSync: (f: string) => unknown }).statSync.bind(null, "/tmp/o.png")).toThrow();
  });

  it("fails with 4 when an expected text is not on the page, and keeps the picture", async () => {
    const w = world({ size: 8000 });
    const missing = await shot.shoot(opts("--expect", "Hello canary", "--expect", "Checkout"), w.deps as never);
    expect(missing.code).toBe(4);
    expect(missing.message).toContain('"Checkout"');
    expect(missing.result!.expected).toEqual([{ text: "Hello canary", found: true }, { text: "Checkout", found: false }]);
    const present = await shot.shoot(opts("--expect", "hello CANARY"), world({ size: 8000 }).deps as never);
    expect(present.code).toBe(0);
  });

  it("starts from a clean file, so an old picture cannot count as this one", async () => {
    const w = world({ size: 0 });
    // The stale picture is there before the run and the run writes nothing: only the removal makes this fail.
    w.files.set("/tmp/o.png", 9000);
    const done = await shot.shoot(opts(), w.deps as never);
    expect(w.removed).toContain("/tmp/o.png");
    expect(done.code).toBe(5);
  });

  describe("--out is a path the command deletes first, so it only replaces a picture", () => {
    const refused = async (setup: (w: ReturnType<typeof world>) => void, ...argv: string[]) => {
      const w = world({ size: 8000 });
      setup(w);
      const done = await shot.shoot(opts(...argv), w.deps as never);
      return { w, done };
    };

    it("refuses a file that is not a PNG, leaves it exactly as it was, and never starts the browser", async () => {
      const { w, done } = await refused((x) => {
        x.files.set("/tmp/o.png", 2400);
        x.heads.set("/tmp/o.png", Buffer.from("export const a = 1;\n"));
      });
      expect(done.code).toBe(2);
      expect(done.message).toContain("already exists and is not a PNG picture");
      expect(done.message).toContain("pick another --out");
      expect(w.removed).toEqual([]);
      expect(w.files.get("/tmp/o.png")).toBe(2400);
      expect(w.calls).toEqual([]);
    });

    it("refuses a directory, and a path it cannot check", async () => {
      const dir = world({ size: 8000 });
      dir.files.set("/tmp/dir.png", 4096);
      const asDir = await shot.shoot(shot.parseArgs(["https://x.test/", "--out", "/tmp/dir.png"]), dir.deps as never);
      expect(asDir.code).toBe(2);
      expect(asDir.message).toContain("is not a file");
      expect(dir.removed).toEqual([]);
      const locked = world({ size: 8000 });
      (locked.deps.fs as { statSync: unknown }).statSync = () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      };
      const done = await shot.shoot(opts(), locked.deps as never);
      expect(done.code).toBe(2);
      expect(done.message).toContain("could not be checked");
      expect(locked.calls).toEqual([]);
    });

    it("replaces a picture, an empty file and nothing", async () => {
      const there = await refused((x) => x.files.set("/tmp/o.png", 9000));
      expect(there.done.code).toBe(0);
      expect(there.w.removed).toContain("/tmp/o.png");
      const empty = await refused((x) => {
        x.files.set("/tmp/o.png", 0);
        x.heads.set("/tmp/o.png", Buffer.alloc(0));
      });
      expect(empty.done.code).toBe(0);
      expect((await refused(() => undefined)).done.code).toBe(0);
    });

    it("a file shorter than a PNG signature is not a PNG", async () => {
      const { done } = await refused((x) => {
        x.files.set("/tmp/o.png", 3);
        x.heads.set("/tmp/o.png", Buffer.from("abc"));
      });
      expect(done.code).toBe(2);
    });

    it("is told before the browser is looked for", async () => {
      const w = world({ chrome: null });
      w.files.set("/tmp/o.png", 100);
      w.heads.set("/tmp/o.png", Buffer.from("not a picture at all"));
      expect((await shot.shoot(opts(), w.deps as never)).code).toBe(2);
    });

    it("outputProblem answers the same without the browser", () => {
      const w = world();
      expect(shot.outputProblem(w.deps.fs, "/tmp/none.png")).toBeNull();
      w.files.set("/tmp/a.png", 500);
      expect(shot.outputProblem(w.deps.fs, "/tmp/a.png")).toBeNull();
      w.heads.set("/tmp/a.png", Buffer.from("MZ......"));
      expect(shot.outputProblem(w.deps.fs, "/tmp/a.png")).toContain("is not a PNG picture");
    });
  });
});

describe("the command", () => {
  const io = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, io: { out: (s: string) => lines.push(s), err: (s: string) => errors.push(s) } };
  };

  it("exits 2 with the usage on a wrong call, and 0 for help", async () => {
    const a = io();
    expect(await shot.main([], a.io)).toBe(2);
    expect(a.errors[0]).toContain("Give the page");
    expect(a.errors[0]).toContain("Exit codes");
    const b = io();
    expect(await shot.main(["--help"], b.io)).toBe(0);
    expect(b.lines[0]).toContain("Takes a headless screenshot");
  });

  it("exits 2 for an --out that is not a picture, in JSON too, and mentions the .png rule in the usage", async () => {
    const a = io();
    expect(await shot.main(["https://x.test/", "--out", "src/app.ts"], a.io, { chrome: null })).toBe(2);
    expect(a.errors[0]).toContain("--out must be a .png file");
    expect(a.errors[0]).toContain("only replaces a PNG");
    const b = io();
    const fs = { statSync: () => ({ size: 120, isFile: () => true }), openSync: () => 1, readSync: (_fd: number, buf: Buffer) => buf.write("#!/bin/sh\n") , closeSync: () => undefined, mkdirSync: () => undefined };
    expect(await shot.main(["https://x.test/", "--json", "--out", "/tmp/script.png"], b.io, { chrome: "/x/chrome", fs } as never)).toBe(2);
    expect(JSON.parse(b.lines[0]!)).toMatchObject({ ok: false, code: 2 });
  });

  it("prints one JSON line with --json, and the exit code of the job", async () => {
    const a = io();
    const code = await shot.main(["https://x.test/", "--json", "--out", "/tmp/o.png"], a.io, { chrome: null });
    expect(code).toBe(3);
    expect(JSON.parse(a.lines[0]!)).toMatchObject({ ok: false, code: 3 });
  });
});
