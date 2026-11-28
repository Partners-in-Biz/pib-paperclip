/**
 * Acting as a person stays in one file (PAR-15315 T2 AC 4). The host lets the Cockpit decide approvals, resolve cards
 * and comment as any active member; `decide-actions.ts` narrows that to the owner. So in src/ the calls that act as a
 * person appear only there: `approvals.decide`, `respondInteraction`, and `actorUserId` inside a `createComment` call.
 * `cockpit.start-hire` (register.ts) passes `actorUserId` to an issue create, not a comment: it is allowed by name.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const HOME = "decide-actions.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The text of each `createComment(...)` call, up to its closing parenthesis. */
function createCommentCalls(source: string): string[] {
  const out: string[] = [];
  const re = /createComment\s*\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") depth -= 1;
    }
    out.push(source.slice(m.index, i));
  }
  return out;
}

/**
 * True when the source reaches the approvals client's `decide`, however it is written: `approvals.decide`,
 * `approvals?.decide`, `approvals["decide"]`, `const { decide } = ….approvals`, or an alias (`const a = ctx.approvals;
 * a.decide(…)`).
 */
function decidesApprovals(source: string): boolean {
  if (/\bapprovals\s*(?:\?\.|\.)\s*decide\b/.test(source)) return true;
  if (/\bapprovals\s*(?:\?\.)?\[\s*["'`]decide["'`]\s*\]/.test(source)) return true;
  if (/\{[^}]*\bdecide\b[^}]*\}\s*=\s*[^;\n]*\bapprovals\b/.test(source)) return true;
  const aliases = [...source.matchAll(/\b(\w+)\s*=\s*[\w.?]*\bapprovals\b\s*[;\n]/g)].map((m) => m[1]!);
  return aliases.some((alias) => new RegExp(`\\b${alias}\\s*(?:\\?\\.|\\.)\\s*decide\\b|\\b${alias}\\s*\\[\\s*["'\`]decide`).test(source));
}

/** Every `actorUserId` use outside decide-actions.ts, by file and line text. Each one must be named here with why. */
const ALLOWED_ACTOR_USER_ID: Record<string, string> = {
  "register.ts": "cockpit.start-hire: the hire issue is created as the signed-in person (startHire, an issue create)",
};

describe("acting as a person (PAR-15315 T2)", () => {
  const all = files(SRC).map((path) => ({ file: relative(SRC, path), text: readFileSync(path, "utf8") }));

  it("approvals.decide and respondInteraction are called only in decide-actions.ts", () => {
    const hits = all.filter((f) => f.file !== HOME && (/\brespondInteraction\b/.test(f.text) || decidesApprovals(f.text))).map((f) => f.file);
    expect(hits).toEqual([]);
    const home = all.find((f) => f.file === HOME)!.text;
    expect(home).toMatch(/approvals\.decide\(/);
    expect(home).toMatch(/respondInteraction\(/);
  });

  it("a createComment call with actorUserId appears only in decide-actions.ts", () => {
    const hits = all.flatMap((f) => (f.file === HOME ? [] : createCommentCalls(f.text).filter((call) => /actorUserId/.test(call)).map((call) => `${f.file}: ${call.slice(0, 120)}`)));
    expect(hits).toEqual([]);
    expect(createCommentCalls(all.find((f) => f.file === HOME)!.text).some((call) => /actorUserId/.test(call))).toBe(true);
  });

  it("every other actorUserId in src/ is allow-listed by file", () => {
    const users = all.filter((f) => f.file !== HOME && /\bactorUserId\b/.test(f.text)).map((f) => f.file);
    expect(users.filter((file) => !(file in ALLOWED_ACTOR_USER_ID))).toEqual([]);
    // register.ts uses it once, in the hire start, and never in a comment.
    const register = all.find((f) => f.file === "register.ts")!.text;
    expect(register.match(/\bactorUserId\b/g)).toHaveLength(1);
    expect(register).toMatch(/startHire\([\s\S]*?actorUserId: userId,[\s\S]*?\}\);/);
  });
});
