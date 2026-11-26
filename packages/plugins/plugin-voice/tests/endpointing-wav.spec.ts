import { describe, expect, it } from "vitest";
import { BargeInDetector, Endpointer, type EndpointEvent } from "../src/ui/endpointing.js";
import { concatPcm16, encodeWav } from "../src/ui/wav.js";

const FRAME = 50;
function run(trace: Array<[level: number, ms: number]>, ep = new Endpointer()): EndpointEvent[] {
  const events: EndpointEvent[] = [];
  for (const [level, ms] of trace) {
    for (let t = 0; t < ms; t += FRAME) {
      const event = ep.push(level, FRAME);
      if (event) events.push(event);
    }
  }
  return events;
}

describe("Endpointer", () => {
  it("speech then silence: start, then end after 1.2 s quiet", () => {
    expect(run([[0, 500], [0.3, 1000], [0, 1150]])).toEqual(["start"]);
    expect(run([[0, 500], [0.3, 1000], [0, 1200]])).toEqual(["start", "end"]);
  });
  it("a short pause inside speech does not end it", () => {
    expect(run([[0.3, 500], [0, 800], [0.3, 500], [0, 1200]])).toEqual(["start", "end"]);
  });
  it("a cough under 150 ms is ignored", () => {
    expect(run([[0, 300], [0.5, 100], [0, 2000]])).toEqual([]);
    expect(run([[0, 300], [0.5, 100], [0, 50], [0.5, 100], [0, 2000]])).toEqual([]);
  });
  it("150 ms of speech starts", () => expect(run([[0.3, 150]])).toEqual(["start"]));
  it("caps an utterance at 90 s", () => {
    expect(run([[0.3, 90_100]])).toEqual(["start", "cap"]);
    const ep = new Endpointer();
    let ms = 0;
    let event: EndpointEvent = null;
    while (event !== "cap") {
      event = ep.push(0.3, FRAME);
      ms += FRAME;
    }
    expect(ms).toBe(90_000);
  });
});

describe("BargeInDetector", () => {
  it("needs 2x the speech level for 300 ms", () => {
    const d = new BargeInDetector();
    let fired = 0;
    for (let i = 0; i < 20; i += 1) if (d.push(0.03, FRAME)) fired += 1; // speech level, not 2x
    expect(fired).toBe(0);
    for (let i = 0; i < 5; i += 1) expect(d.push(0.05, FRAME)).toBe(false);
    expect(d.push(0.05, FRAME)).toBe(true); // 6 x 50 ms = 300 ms
  });
  it("a gap restarts the count", () => {
    const d = new BargeInDetector();
    for (let i = 0; i < 5; i += 1) d.push(0.1, FRAME);
    d.push(0, FRAME);
    expect(d.push(0.1, FRAME)).toBe(false);
  });
});

describe("encodeWav", () => {
  it("pins the header and data bytes for 3 samples", () => {
    const bytes = new Uint8Array(encodeWav(new Int16Array([0, 1, -2])));
    const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(
      "52494646" + "2a000000" + "57415645" + // RIFF, 36+6, WAVE
      "666d7420" + "10000000" + "0100" + "0100" + "c05d0000" + "80bb0000" + "0200" + "1000" + // fmt: PCM mono 24000 Hz
      "64617461" + "06000000" + // data, 6 bytes
      "000001" + "00" + "feff", // samples 0, 1, -2 little-endian
    );
  });
  it("joins frames", () => {
    const a = new Int16Array([1, 2]).buffer;
    const b = new Int16Array([3]).buffer;
    expect([...concatPcm16([a, b])]).toEqual([1, 2, 3]);
  });
});
