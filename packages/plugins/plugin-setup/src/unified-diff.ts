export type DiffResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Applies a unified diff to raw text. Strict validation (no fuzz), exact
 * position matching, normalizes CRLF to LF, preserves trailing newlines.
 */
export function applyUnifiedDiff(raw: string, diff: string): DiffResult {
  raw = raw.replace(/\r\n/g, "\n");
  diff = diff.replace(/\r\n/g, "\n");

  if (diff.length > 200_000) return { ok: false, error: "diff exceeds 200_000 characters" };

  const diffLines = diff.split("\n");
  let startIdx = diffLines.findIndex((l) => l.startsWith("@@"));
  if (startIdx === -1) return { ok: false, error: "diff has no @@ hunk header" };

  const hunks: Array<{ start: number; count: number; lines: string[] }> = [];
  let i = startIdx;

  while (i < diffLines.length && diffLines[i]!.startsWith("@@")) {
    const m = diffLines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) return { ok: false, error: `malformed hunk header at line ${i + 1}` };

    const oldStart = parseInt(m[1]!, 10);
    const oldCnt = m[2] ? parseInt(m[2]!, 10) : 1;
    const hunkLines: string[] = [];
    let oldLn = 0, newLn = 0;
    i++;

    while (i < diffLines.length && !diffLines[i]!.startsWith("@@")) {
      const ln = diffLines[i]!;
      if (ln.startsWith("\\")) {
        i++;
        continue;
      }
      if (ln.length === 0) {
        i++;
        break;
      }

      if (ln[0] === " ") {
        hunkLines.push(ln.slice(1));
        oldLn++;
        newLn++;
      } else if (ln[0] === "-") {
        hunkLines.push("-" + ln.slice(1));
        oldLn++;
      } else if (ln[0] === "+") {
        hunkLines.push("+" + ln.slice(1));
        newLn++;
      } else {
        return { ok: false, error: `hunk ${hunks.length + 1}: invalid line prefix at line ${i + 1}` };
      }
      i++;
    }

    const newCnt = m[4] ? parseInt(m[4]!, 10) : 1;
    if (oldLn !== oldCnt) return { ok: false, error: `hunk ${hunks.length + 1}: expected ${oldCnt} old lines, got ${oldLn}` };
    if (newLn !== newCnt) return { ok: false, error: `hunk ${hunks.length + 1}: expected ${newCnt} new lines, got ${newLn}` };
    hunks.push({ start: oldStart, count: oldCnt, lines: hunkLines });
  }

  if (hunks.length === 0) return { ok: false, error: "diff is empty" };

  for (let j = 0; j < hunks.length - 1; j++) {
    const end = hunks[j]!.start + hunks[j]!.count - 1;
    if (hunks[j + 1]!.start <= end) {
      return { ok: false, error: `hunks ${j + 1} and ${j + 2} overlap or are out of order` };
    }
  }

  const rawLines = raw.split("\n");
  const hasNL = raw.endsWith("\n");
  let result = rawLines;

  for (let j = hunks.length - 1; j >= 0; j--) {
    const h = hunks[j]!;
    const idx = h.start - 1;
    const hNum = j + 1;

    if (idx < 0 || idx > result.length || idx + h.count > result.length) {
      return { ok: false, error: `hunk ${hNum}: old-start ${h.start} out of bounds` };
    }

    let lIdx = idx;
    for (const hl of h.lines) {
      if (!hl.startsWith("+")) {
        const content = hl.startsWith("-") ? hl.slice(1) : hl;
        if (result[lIdx] !== content) {
          const exp = content.slice(0, 80);
          const found = (result[lIdx] || "").slice(0, 80);
          return { ok: false, error: `hunk ${hNum} line ${lIdx + 1}: expected "${exp}", found "${found}"` };
        }
        lIdx++;
      }
    }

    const newLines = h.lines
      .filter((l) => !l.startsWith("-"))
      .map((l) => (l.startsWith("+") ? l.slice(1) : l));
    result.splice(idx, h.count, ...newLines);
  }

  let text = result.join("\n");
  if (hasNL && !text.endsWith("\n")) text += "\n";
  else if (!hasNL && text.endsWith("\n")) text = text.slice(0, -1);

  return { ok: true, text };
}
