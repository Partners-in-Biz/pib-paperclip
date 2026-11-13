/** Guard (PAR-10892): every reader of lifecycle `lead` must use the newsletter-origin helper or be on this allowlist. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;

/** A reader of lifecycle `lead`: SQL `lifecycle = 'lead'`, `lifecycle IN (... 'lead' ...)`, or a TS comparison on a lifecycle field. */
const READER = [
  /lifecycle\s*=\s*'lead'/,
  /lifecycle\s+IN\s*\([^)]*'lead'/i,
  /lifecycle\s*(?:===|!==|==|!=)\s*["']lead["']/,
  /["']lead["']\s*(?:===|!==|==|!=)\s*[\w.?]*lifecycle/,
];

/** file -> a text the allowed line must contain. Writers (`lifecycle: "lead"`) are not readers and need no entry. */
const ALLOW: Record<string, string> = {
  "mail.ts": "Decision (PAR-10817)", // a subscriber's reply goes to the Inbound Qualifier, on purpose
  "done-checks.ts": "contact.lifecycle !== \"lead\"", // "was a decision made": not a count of leads
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/generated/.test(name) ? [path] : [];
  });
}

export function findReaders(sources: Array<{ file: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!READER.some((re) => re.test(line))) return;
      if (line.includes("NOT_NEWSLETTER_ORIGIN_SQL") || /^\s*(\/\/|\*)/.test(line)) return;
      const base = file.split("/").pop()!;
      const near = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
      const allowed = ALLOW[base];
      if (allowed && near.includes(allowed)) return;
      // A cockpit query line is fine when the helper is in the same query (next lines of the same SELECT).
      if (lines.slice(i, i + 1).join("").includes("NOT_NEWSLETTER_ORIGIN_SQL")) return;
      hits.push(`${base}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe("readers of lifecycle lead", () => {
  const sources = files(SRC).map((file) => ({ file, text: readFileSync(file, "utf8") }));

  it("every reader uses the newsletter-origin helper or is allowlisted", () => {
    expect(findReaders(sources)).toEqual([]);
  });

  it("fails on a planted reader", () => {
    const planted = [{ file: "planted.ts", text: "const q = `SELECT 1 FROM c WHERE lifecycle = 'lead'`;" }];
    expect(findReaders(planted)).toHaveLength(1);
    expect(findReaders([{ file: "ok.ts", text: "WHERE lifecycle = 'lead' AND ${NOT_NEWSLETTER_ORIGIN_SQL}" }])).toEqual([]);
  });
});
