#!/usr/bin/env node
/**
 * pib-shot: take a headless screenshot of a page, so a developer or tester
 * agent can LOOK at what it built (audit Q5-5: Penny's guide said agents cannot
 * open a browser while Chromium sat installed, so most UI issues closed with
 * "not checked").
 *
 *   pib-shot <url> [--out <file.png>] [--viewport desktop|mobile|tablet|<W>x<H>]
 *            [--wait <ms>] [--timeout <seconds>] [--expect <text>]... [--json]
 *
 * It drives the Chrome or Chromium that is already installed (no Playwright, no
 * download): headless, one page, one PNG. `--expect` also reads the rendered
 * page and fails (exit 4) when a text is not on it, so "the heading is there" is a
 * check and not a guess. `--json` prints one JSON line (path, bytes, sha256), the
 * evidence to attach to the issue.
 *
 * `--out` must end in .png, and it only ever replaces a PNG (or an empty file, or
 * nothing): the command deletes what is at that path before it takes the picture,
 * so a mistyped `--out src/app.ts` is refused instead of destroying the file.
 *
 * Exit codes: 0 done, 2 wrong usage, 3 no browser found, 4 an --expect text is not
 * on the page, 5 no usable screenshot (the page did not load, or the file is too
 * small to be one).
 *
 * Install (done by the deploy, not by agents): copy this file to
 * /home/paperclip/pib-tools/pib-shot, owned by paperclip, mode 755. Plain Node,
 * no dependencies; written as CommonJS so it runs under any file name.
 */
"use strict";

const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false },
  tablet: { width: 768, height: 1024, mobile: true },
  mobile: { width: 390, height: 844, mobile: true },
};
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MIN_BYTES = 2000;
const DEFAULT_WAIT_MS = 3000;
const DEFAULT_TIMEOUT_S = 45;

class UsageError extends Error {}

/** `--flag value` and `--flag=value`; `--expect` may repeat. Returns the parsed options or throws UsageError. */
function parseArgs(argv) {
  const opts = { url: null, out: null, viewport: "desktop", wait: DEFAULT_WAIT_MS, timeout: DEFAULT_TIMEOUT_S, expect: [], json: false, help: false };
  const takes = new Set(["out", "viewport", "wait", "timeout", "expect"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!takes.has(name)) throw new UsageError(`Unknown option --${name}.`);
      let value;
      if (eq > 0) value = arg.slice(eq + 1);
      else {
        i += 1;
        value = argv[i];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      }
      if (name === "expect") opts.expect.push(value);
      else if (name === "wait" || name === "timeout") {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number.`);
        opts[name] = n;
      } else opts[name] = value;
      continue;
    }
    if (opts.url !== null) throw new UsageError(`Only one page at a time (got "${opts.url}" and "${arg}").`);
    opts.url = arg;
  }
  if (opts.help) return opts;
  if (!opts.url) throw new UsageError("Give the page to photograph: pib-shot <url>.");
  if (opts.out !== null && !/\.png$/i.test(opts.out)) throw new UsageError(`--out must be a .png file (the picture is a PNG), not "${opts.out}". The command replaces whatever is at that path, so it will not take a name that is not a picture.`);
  checkUrl(opts.url);
  viewportOf(opts.viewport);
  if (opts.wait > 60_000) throw new UsageError("--wait is in milliseconds and at most 60000.");
  if (opts.timeout < 5 || opts.timeout > 300) throw new UsageError("--timeout is in seconds, from 5 to 300.");
  return opts;
}

/** Only pages: http, https, or a local file. Never javascript:, data: or a page with a login in the address. */
function checkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not an address (use http://, https:// or file://).`);
  }
  if (!["http:", "https:", "file:"].includes(url.protocol)) throw new UsageError(`Only http, https and file addresses can be photographed, not ${url.protocol}`);
  if (url.username || url.password) throw new UsageError("Do not put a login in the address: the photo and the issue would carry it.");
  return url;
}

/** `desktop`, `tablet`, `mobile` or `<W>x<H>` (200 to 4000 each). */
function viewportOf(value) {
  if (VIEWPORTS[value]) return { name: value, ...VIEWPORTS[value] };
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  if (!m) throw new UsageError(`--viewport is desktop, tablet, mobile or <width>x<height> (for example 1280x2400), not "${value}".`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 200 || width > 4000 || height < 200 || height > 4000) throw new UsageError("--viewport sides are from 200 to 4000.");
  return { name: `${width}x${height}`, width, height, mobile: width < 700 };
}

/** Where the picture goes when --out is not given: a folder agents can write, a name that says what it shows. */
function defaultOut(url, viewportName, now = new Date()) {
  const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "-") || "page";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return path.join(os.tmpdir(), "pib-shots", `${host}-${viewportName}-${stamp}.png`);
}

/** The headless shell is the browser built for this job: it exits by itself. Full Chrome is the fallback (on the server it never finished a screenshot, so it is last). */
function isHeadlessShell(file) {
  return /headless[_-]shell/i.test(path.basename(String(file)));
}

/** The browsers to try, in order: the one named, Playwright's headless shell, Playwright's Chromium, then the system's. */
function chromeCandidates(env = process.env, platform = process.platform, home = os.homedir(), readdir = (dir) => fs.readdirSync(dir)) {
  const list = [];
  if (env.PIB_SHOT_CHROME) list.push(env.PIB_SHOT_CHROME);
  const cache = path.join(env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, ".cache", "ms-playwright"));
  try {
    const dirs = readdir(cache);
    for (const dir of dirs.filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse()) {
      list.push(path.join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"), path.join(cache, dir, "chrome-linux", "headless_shell"));
    }
    for (const dir of dirs.filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) list.push(path.join(cache, dir, "chrome-linux64", "chrome"));
  } catch {
    // no Playwright cache
  }
  if (platform === "darwin") list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  else list.push("/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  return list;
}

function findChrome(candidates = chromeCandidates(), exists = fs.existsSync) {
  return candidates.find((c) => c && exists(c)) || null;
}

/** The argument list for one browser run. `dom` dumps the rendered page instead of taking a picture; `shell` is the headless shell (it has no --headless switch). */
function buildChromeArgs(opts, outFile, viewport, userDataDir, dom = false, shell = false) {
  const args = [
    ...(shell ? [] : ["--headless=new"]),
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    `--virtual-time-budget=${Math.max(0, Math.round(opts.wait))}`,
  ];
  if (viewport.mobile) args.push(`--user-agent=${MOBILE_UA}`);
  if (dom) args.push("--dump-dom");
  else args.push(`--screenshot=${outFile}`);
  args.push(opts.url);
  return args;
}

/**
 * Why a page is no evidence, or null for a real page. A connection that failed shows
 * the browser's own error page (full Chrome puts its markers in the DOM; the headless
 * shell leaves the DOM empty), and a blank page proves nothing either.
 */
function loadError(dom) {
  const text = String(dom);
  if (/id="main-frame-error"|class="[^"]*\bneterror\b/.test(text)) return (/\b(ERR_[A-Z_]{4,})\b/.exec(text) || [])[1] || "the browser's error page";
  const visible = text.replace(/<head\b[\s\S]*?<\/head>/gi, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  if (visible === "" && !/<(img|canvas|svg|video|iframe|input|button|textarea|select)\b/i.test(text)) return "the page rendered nothing";
  return null;
}

/** Which --expect texts are on the page (case does not matter, nor does spacing). */
function checkExpected(dom, expect) {
  const flat = String(dom).replace(/\s+/g, " ").toLowerCase();
  return expect.map((text) => ({ text, found: flat.includes(String(text).replace(/\s+/g, " ").toLowerCase()) }));
}

/**
 * Runs the browser. Some Chrome builds write the picture and then never exit, so a
 * run also ends (and the whole browser, helpers included, is killed) as soon as
 * `isDone` has said yes on two polls in a row, instead of waiting out the timeout.
 */
function run(file, args, timeoutMs, isDone) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer = null;
    let poll = null;
    let child = null;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      try {
        if (child && child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          if (child) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      resolve({ error, stdout, stderr });
    };
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      resolve({ error, stdout, stderr });
      return;
    }
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > 64 * 1024 * 1024) finish(new Error("the page printed too much"));
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 4000) stderr += d;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code ? new Error(`the browser exited with code ${code}`) : null));
    timer = setTimeout(() => finish(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    if (isDone) {
      let before = false;
      poll = setInterval(() => {
        let now = false;
        try {
          now = isDone(stdout);
        } catch {
          now = false;
        }
        if (now && before) finish(null);
        before = now;
      }, 300);
    }
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Why the command will not write to this path, or null. It deletes what is there
 * first (an old picture must not count as this run's), so what is there must be a
 * PNG, an empty file or nothing. A directory, a source file or anything it cannot
 * check is refused.
 */
function outputProblem(fsx, out) {
  let st;
  try {
    st = fsx.statSync(out);
  } catch (error) {
    if (error && (error.code === "ENOENT" || /ENOENT/.test(String(error.message)))) return null;
    return `${out} could not be checked (${String((error && error.message) || error).split("\n")[0].slice(0, 120)})`;
  }
  if (typeof st.isFile === "function" && !st.isFile()) return `${out} is not a file`;
  if (st.size === 0) return null;
  let fd;
  try {
    fd = fsx.openSync(out, "r");
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    const read = fsx.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(PNG_SIGNATURE) ? null : `${out} already exists and is not a PNG picture`;
  } catch (error) {
    return `${out} could not be checked (${String((error && error.message) || error).split("\n")[0].slice(0, 120)})`;
  } finally {
    try {
      if (fd !== undefined) fsx.closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

/** Does the whole job. `deps` lets a test swap the browser, the disk and the clock. */
async function shoot(opts, deps = {}) {
  const fsx = deps.fs || fs;
  const runner = deps.run || run;
  const viewport = viewportOf(opts.viewport);
  const out = path.resolve(opts.out || defaultOut(opts.url, viewport.name, deps.now ? deps.now() : new Date()));
  // A usage mistake is told before anything else, and before anything is deleted.
  const refused = outputProblem(fsx, out);
  if (refused) return { code: 2, message: `${refused}. pib-shot deletes what is at --out before it takes the picture, so it only replaces a PNG: pick another --out.` };
  const chrome = deps.chrome !== undefined ? deps.chrome : findChrome();
  if (!chrome) return { code: 3, message: "No Chrome or Chromium found. Set PIB_SHOT_CHROME to its path, or ask the Operator to install one." };
  fsx.mkdirSync(path.dirname(out), { recursive: true });
  // A picture left by an earlier run must not count as this run's.
  fsx.rmSync(out, { force: true });
  const profile = fsx.mkdtempSync(path.join(os.tmpdir(), "pib-shot-"));
  try {
    // Done when the picture is on disk and has stopped growing.
    let lastSize = -1;
    const shell = isHeadlessShell(chrome);
    const shot = await runner(chrome, buildChromeArgs(opts, out, viewport, profile, false, shell), opts.timeout * 1000, () => {
      let size = 0;
      try {
        size = fsx.statSync(out).size;
      } catch {
        size = 0;
      }
      const settled = size >= MIN_BYTES && size === lastSize;
      lastSize = size;
      return settled;
    });
    let bytes = 0;
    try {
      bytes = fsx.statSync(out).size;
    } catch {
      bytes = 0;
    }
    if (bytes < MIN_BYTES) {
      const why = shot.error ? String(shot.error.message || shot.error).split("\n")[0].slice(0, 200) : "the file is empty";
      return { code: 5, message: `No usable screenshot (${bytes} bytes): ${why}. Is the address reachable from this machine?` };
    }
    const result = { ok: true, path: out, bytes, sha256: createHash("sha256").update(fsx.readFileSync(out)).digest("hex"), url: opts.url, viewport: viewport.name, expected: [] };
    // Read the page the picture is of: a page that did not load shows the browser's own error page, and that is no proof of anything.
    const dom = await runner(chrome, buildChromeArgs(opts, out, viewport, profile, true, shell), opts.timeout * 1000, (text) => /<\/html>\s*$/i.test(text));
    const failure = loadError(dom.stdout);
    if (failure) {
      fsx.rmSync(out, { force: true });
      return { code: 5, message: `The page is no evidence (${failure}), so the picture was thrown away. Is the address reachable from this machine, and is the server running?` };
    }
    if (opts.expect.length) {
      result.expected = checkExpected(dom.stdout, opts.expect);
      if (result.expected.some((e) => !e.found)) {
        result.ok = false;
        return { code: 4, message: `The picture is at ${out}, but this text is not on the page: ${result.expected.filter((e) => !e.found).map((e) => JSON.stringify(e.text)).join(", ")}.`, result };
      }
    }
    return { code: 0, message: `Screenshot: ${out} (${bytes} bytes, ${viewport.name})`, result };
  } finally {
    try {
      fsx.rmSync(profile, { recursive: true, force: true });
    } catch {
      // a leftover temp profile is harmless
    }
  }
}

const HELP = `pib-shot <url> [--out file.png] [--viewport desktop|mobile|tablet|WxH] [--wait ms] [--timeout s] [--expect text]... [--json]
Takes a headless screenshot with the Chrome already on this machine. --expect fails (exit 4) when a text is not on the rendered page.
--out must end in .png and only replaces a PNG (never another kind of file).
Exit codes: 0 done, 2 wrong usage, 3 no browser, 4 expected text missing, 5 no usable screenshot.`;

async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }, deps = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${error.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    io.out(HELP);
    return 0;
  }
  const done = await shoot(opts, deps);
  if (opts.json) io.out(JSON.stringify(done.result ? { ...done.result, code: done.code, message: done.message } : { ok: false, code: done.code, message: done.message }));
  else (done.code === 0 ? io.out : io.err)(done.message);
  return done.code;
}

module.exports = { parseArgs, viewportOf, checkUrl, defaultOut, outputProblem, isHeadlessShell, chromeCandidates, findChrome, buildChromeArgs, checkExpected, loadError, shoot, main, UsageError, MIN_BYTES };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`pib-shot failed: ${error && error.message ? error.message : error}\n`);
      process.exit(1);
    },
  );
}
