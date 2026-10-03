/**
 * 0.22.0 (ops/preview-server): the client preview service saved a PNG per review shot and ran Chromium with
 * HOME=/tmp, and never deleted anything (634 MB and 157 screenshots after 14 hours in a private /tmp the janitor
 * cannot see). Screenshots now go after an hour and every Chromium run has a profile folder of its own that is
 * removed when it ends. The service is deployed separately from the plugin (server.mjs + sweep.mjs).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chromiumEnv, domArgs, makeProfile, PROFILE_NAME, removeProfile, SHOT_MAX_AGE_MS, SHOT_NAME, shotArgs, sweepProfiles, sweepShots } from "../ops/preview-server/sweep.mjs";

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "seo-sweep-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const age = (path: string, ms: number) => {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
};

describe("sweepShots", () => {
  it("deletes screenshots older than an hour and nothing else", async () => {
    const dir = scratch();
    const old = [`${TOKEN}-live.png`, `${TOKEN}-proposed.png`, `${TOKEN}-live-m.png`, `${TOKEN}-proposed-m.png`];
    for (const name of old) {
      writeFileSync(join(dir, name), "png");
      age(join(dir, name), SHOT_MAX_AGE_MS + 60_000);
    }
    writeFileSync(join(dir, `${"Z".repeat(30)}-live.png`), "fresh");
    // Names the service never creates stay, however old.
    for (const name of ["notes.txt", "short-live.png", `${TOKEN}-other.png`, `${TOKEN}-live.png.bak`, ".hidden.png"]) {
      writeFileSync(join(dir, name), "keep");
      age(join(dir, name), 10 * SHOT_MAX_AGE_MS);
    }
    mkdirSync(join(dir, `${TOKEN}-live-m.png.d`));
    expect(await sweepShots(dir)).toBe(4);
    expect(readdirSync(dir).sort()).toEqual([`${"Z".repeat(30)}-live.png`, `${TOKEN}-live-m.png.d`, `${TOKEN}-live.png.bak`, `${TOKEN}-other.png`, ".hidden.png", "notes.txt", "short-live.png"].sort());
    // A second call has nothing left to do.
    expect(await sweepShots(dir)).toBe(0);
  });

  it("keeps a screenshot just inside the hour, honours another age, and copes with a missing folder", async () => {
    const dir = scratch();
    writeFileSync(join(dir, `${TOKEN}-live.png`), "png");
    age(join(dir, `${TOKEN}-live.png`), SHOT_MAX_AGE_MS - 30_000);
    expect(await sweepShots(dir)).toBe(0);
    expect(await sweepShots(dir, Date.now() + 120_000)).toBe(1);
    expect(await sweepShots(join(dir, "nope"))).toBe(0);
  });

  it("removes a link, not what it points at", async () => {
    const dir = scratch();
    const target = join(scratch(), "precious.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, `${TOKEN}-live.png`));
    // lstat of the link is fresh, so use a clock far enough ahead for the sweep to take it
    await sweepShots(dir, Date.now() + 2 * SHOT_MAX_AGE_MS);
    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("matches exactly the names the service writes", () => {
    for (const name of [`${TOKEN}-live.png`, `${TOKEN}-proposed-m.png`, `${"a_b-".repeat(8)}-live.png`]) expect(SHOT_NAME.test(name), name).toBe(true);
    for (const name of ["x-live.png", `${TOKEN}-live.jpg`, `${TOKEN}/live.png`, `../${TOKEN}-live.png`, `${"A".repeat(65)}-live.png`]) expect(SHOT_NAME.test(name), name).toBe(false);
  });
});

describe("Chromium profile folders", () => {
  it("makeProfile gives a private folder and cleanup removes it with its contents, without throwing twice", async () => {
    const root = join(scratch(), "profiles");
    const profile = await makeProfile(root);
    expect(PROFILE_NAME.test(profile.dir.slice(root.length + 1))).toBe(true);
    expect(statSync(root).mode & 0o077).toBe(0);
    mkdirSync(join(profile.dir, "Default"));
    writeFileSync(join(profile.dir, "Default", "Cache"), "cache");
    await profile.cleanup();
    expect(existsSync(profile.dir)).toBe(false);
    expect(existsSync(root)).toBe(true);
    await expect(profile.cleanup()).resolves.toBeUndefined();
  });

  it("two runs never share a folder", async () => {
    const root = scratch();
    const [a, b] = [await makeProfile(root), await makeProfile(root)];
    expect(a.dir).not.toBe(b.dir);
    await Promise.all([a.cleanup(), b.cleanup()]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("sweepProfiles removes folders a killed run left behind, and only those", async () => {
    const root = scratch();
    const stale = await makeProfile(root);
    writeFileSync(join(stale.dir, "SingletonLock"), "x");
    age(stale.dir, SHOT_MAX_AGE_MS + 60_000);
    const fresh = await makeProfile(root);
    mkdirSync(join(root, "keep-me"));
    age(join(root, "keep-me"), 10 * SHOT_MAX_AGE_MS);
    writeFileSync(join(root, "p-file12"), "a file, not a folder the service made");
    age(join(root, "p-file12"), 10 * SHOT_MAX_AGE_MS);
    expect(await sweepProfiles(root)).toBe(2);
    expect(existsSync(stale.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    expect(existsSync(join(root, "keep-me"))).toBe(true);
  });

  it("removeProfile refuses anything that is not a profile folder directly under the root", async () => {
    const outer = scratch();
    const root = join(outer, "profiles");
    const profile = await makeProfile(root);
    mkdirSync(join(profile.dir, "p-inner1"));
    mkdirSync(join(outer, "p-other1"));
    for (const target of [root, outer, tmpdir(), "/", join(root, "keep-me"), join(profile.dir, "p-inner1"), join(root, "..", "p-other1"), join(root, `${profile.dir.slice(root.length + 1)}/..`)]) {
      await expect(removeProfile(root, target), target).rejects.toThrow(/refusing to remove/);
    }
    expect(existsSync(join(outer, "p-other1"))).toBe(true);
    expect(existsSync(join(profile.dir, "p-inner1"))).toBe(true);
    await expect(removeProfile(root, profile.dir)).resolves.toBeUndefined();
    expect(existsSync(profile.dir)).toBe(false);
  });
});

describe("how Chromium is run", () => {
  it("keeps everything inside the run's profile folder", () => {
    const env = chromiumEnv("/tmp/p/p-abc123", { PATH: "/usr/bin", HOME: "/home/x", DATABASE: "kept" });
    expect(env).toMatchObject({ PATH: "/usr/bin", DATABASE: "kept", HOME: "/tmp/p/p-abc123", TMPDIR: "/tmp/p/p-abc123", XDG_CONFIG_HOME: "/tmp/p/p-abc123", XDG_CACHE_HOME: "/tmp/p/p-abc123" });
  });

  it("gives every run a throwaway profile (a persistent one never finishes on this Chromium: checked on the VPS)", () => {
    const dir = "/tmp/p/p-abc123";
    const shot = shotArgs(dir, "https://x.test/", "/tmp/s/t-live.png");
    const dom = domArgs(dir, "https://x.test/");
    for (const args of [shot, dom]) {
      expect(args).toEqual(expect.arrayContaining(["--headless=new", "--no-sandbox", "--incognito", "--no-first-run", `--user-data-dir=${dir}`, "--virtual-time-budget=9000"]));
      expect(args.at(-1)).toBe("https://x.test/");
    }
    expect(shot).toEqual(expect.arrayContaining(["--window-size=1280,3200", "--hide-scrollbars", "--screenshot=/tmp/s/t-live.png"]));
    expect(shot.some((a) => a.startsWith("--user-agent="))).toBe(false);
    expect(dom).toContain("--dump-dom");
    const phone = shotArgs(dir, "https://x.test/", "/tmp/s/t-live-m.png", true);
    expect(phone).toContain("--window-size=390,3000");
    expect(phone.find((a) => a.startsWith("--user-agent="))).toMatch(/iPhone/);
  });
});

describe("server.mjs", () => {
  const source = readFileSync(new URL("../ops/preview-server/server.mjs", import.meta.url), "utf8");

  it("sweeps on every call that starts Chromium and at startup, and no longer runs Chromium in /tmp itself", () => {
    expect(source).toContain('from "./sweep.mjs"');
    expect(source).not.toMatch(/HOME:\s*"\/tmp"/);
    // renderedDom, screenshot and shotFor each sweep first; the server also sweeps once it is listening.
    expect((source.match(/await housekeeping\(\)/g) ?? []).length).toBe(3);
    expect(source).toMatch(/server\.listen\([\s\S]*void housekeeping\(\)/);
    expect(source).toContain("withChromium(");
    expect(source).toContain("domArgs(dir, url)");
    expect(source).toContain("shotArgs(dir, url, file, mobile)");
  });

  it("never serves a cached screenshot in the last minutes before the sweep takes it", () => {
    expect(source).toContain("SHOT_MAX_AGE_MS - 300_000");
    expect(source).toMatch(/Date\.now\(\) - st\.mtimeMs < SHOT_REUSE_MS/);
  });
});
