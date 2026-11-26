import { describe, expect, it } from "vitest";
import { isPlanningCanvasWebLinkUrl, parseYouTubeUrl } from "./planning-canvas-weblink.js";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl (PAR-14389 C.5)", () => {
  it("accepts each listed host and form and returns the bare id", () => {
    for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"]) {
      for (const path of [`/watch?v=${ID}`, `/shorts/${ID}`, `/embed/${ID}`, `/live/${ID}`]) {
        expect(parseYouTubeUrl(`https://${host}${path}`), `${host}${path}`).toBe(ID);
      }
    }
    expect(parseYouTubeUrl(`https://youtu.be/${ID}`)).toBe(ID);
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=42&si=abc`)).toBe(ID);
    expect(parseYouTubeUrl(`https://WWW.YouTube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?feature=share&v=${ID}&t=10s#x`)).toBe(ID);
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=a-b_c1D2e3F")).toBe("a-b_c1D2e3F");
  });

  it("drops the query of an embed form: embed/<id>?autoplay=1&... gives the bare id", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/embed/${ID}?autoplay=1&mute=1&origin=https://evil.test`)).toBe(ID);
    expect(parseYouTubeUrl(`https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&controls=0`)).toBe(ID);
  });

  it("refuses look-alike hosts and hosts in the path", () => {
    for (const url of [
      `https://youtube.com.evil.test/watch?v=${ID}`,
      `https://evil.test/youtube.com/watch?v=${ID}`,
      `https://evil.test/watch?v=${ID}&host=youtube.com`,
      `https://notyoutube.com/watch?v=${ID}`,
      `https://evilyoutube.com/watch?v=${ID}`,
      `https://youtube.com./watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtube-nocookie.com/embed/${ID}`,
      `https://youtu.be.evil.test/${ID}`,
      `https://www.youtu.be/${ID}`,
      `https://evil.test/youtu.be/${ID}`,
      `https://evil.test#youtube.com/watch?v=${ID}`,
      `https://www.youtube.com@evil.test/watch?v=${ID}`,
      `https://user@www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com:8443/watch?v=${ID}`,
    ]) {
      expect(parseYouTubeUrl(url), url).toBeNull();
    }
  });

  it("refuses ids with extra or missing characters and unknown forms", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}x`,
      `https://www.youtube.com/watch?v=${ID.slice(1)}`,
      `https://www.youtube.com/watch?v=${ID}%22`,
      `https://www.youtube.com/watch?v=dQw4w9WgXc!`,
      `https://www.youtube.com/watch?v=${ID}&v=${ID}`,
      `https://www.youtube.com/watch`,
      `https://www.youtube.com/embed/${ID}x`,
      `https://www.youtube.com/embed/${ID}/extra`,
      `https://www.youtube.com/embed/%64Qw4w9WgXcQ`,
      `https://www.youtube.com/shorts/${ID}.js`,
      `https://www.youtube.com/v/${ID}`,
      `https://www.youtube.com/${ID}`,
      `https://www.youtube.com/watchx?v=${ID}`,
      `https://www.youtube.com/embed/?v=${ID}`,
      `https://youtu.be/${ID}x`,
      `https://youtu.be/embed/${ID}`,
      `https://youtu.be/watch?v=${ID}`,
    ]) {
      expect(parseYouTubeUrl(url), url).toBeNull();
    }
  });

  it("refuses anything the web link rule refuses (http:, javascript:, userinfo, too long)", () => {
    for (const url of [
      `http://www.youtube.com/watch?v=${ID}`,
      `javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&pad=${"a".repeat(2000)}`,
      ` https://youtu.be/${ID}`,
      "",
      "not a url",
    ]) {
      expect(parseYouTubeUrl(url), url).toBeNull();
      expect(isPlanningCanvasWebLinkUrl(url) && parseYouTubeUrl(url) !== null).toBe(false);
    }
  });
});
