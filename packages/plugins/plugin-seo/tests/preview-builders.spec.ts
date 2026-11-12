import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreviewHtml } from "../src/engine/preview.js";
import { BUILDER_CASES, BUILDER_MODES } from "./fixtures/builders/cases.js";

// PAR-10107: builder layouts, a flex wrapper and plain pages keep exactly the preview development built before the
// card-aware insertion point. expected.json was generated on development before the engine change.
const EXPECTED = resolve("tests/fixtures/builders/expected.json");
const opts = { token: "tok", clientName: "Acme" };

function build(html: string, mode: (typeof BUILDER_MODES)[number]): string {
  const changes = mode === "h1" ? { h1: "New heading" } : { bodyHtml: "<p>NEW</p>", bodyMode: mode };
  const out = buildPreviewHtml(html, "https://x.co.za/page/", changes, opts).html;
  // The answer bar is the same on every preview; leave it out so the stored outputs stay small.
  const bar = /<div id="pib-preview-bar"[\s\S]*?<div style="height:64px"><\/div>/;
  expect(out).toMatch(bar);
  return out.replace(bar, "<!--bar-->");
}

describe("buildPreviewHtml on builder and plain layouts (PAR-10107)", () => {
  const actual: Record<string, Record<string, string>> = {};
  for (const [name, html] of Object.entries(BUILDER_CASES)) {
    actual[name] = Object.fromEntries(BUILDER_MODES.map((mode) => [mode, build(html, mode)]));
  }
  if (process.env.UPDATE_BUILDER_EXPECTED === "1") writeFileSync(EXPECTED, `${JSON.stringify(actual, null, 1)}\n`);
  const expected = existsSync(EXPECTED) ? (JSON.parse(readFileSync(EXPECTED, "utf-8")) as typeof actual) : {};

  for (const name of Object.keys(BUILDER_CASES)) {
    for (const mode of BUILDER_MODES) {
      it(`${name} ${mode} is byte-identical to development`, () => {
        expect(expected[name]?.[mode]).toBeTypeOf("string");
        expect(actual[name]![mode]).toBe(expected[name]![mode]);
      });
    }
  }
});
