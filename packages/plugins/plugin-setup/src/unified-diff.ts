export type ApplyResult = { ok: true; text: string } | { ok: false; error: string };

type Op = { type: "context" | "remove" | "add"; line: string };

export function applyUnifiedDiff(source: string, diff: string): ApplyResult {
  const diffNorm = diff.replace(/\r\n/g, "\n");
  const srcNorm = source.replace(/\r\n/g, "\n");
  const hasTrailNewline = srcNorm.endsWith("\n");
  const srcLines = srcNorm.split("\n");
  if (hasTrailNewline && srcLines.length > 0) srcLines.pop();

  let diffLines = diffNorm.split("\n");
  // If diff ends with "\n", split leaves a trailing empty string; drop it.
  // Interior empty lines (blank context lines) are preserved.
  if (diffNorm.endsWith("\n") && diffLines.length > 0 && diffLines[diffLines.length - 1] === "") {
    diffLines = diffLines.slice(0, -1);
  }

  const hunkStart = diffLines.findIndex((l) => l.startsWith("@@"));
  if (hunkStart === -1) return { ok: false, error: "diff has no hunks" };

  const result = [...srcLines];
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let idx = hunkStart;
  let hunkNum = 0;
  let prevEnd = -1;
  let offset = 0;

  while (idx < diffLines.length && diffLines[idx].startsWith("@@")) {
    hunkNum++;
    const m = hunkRegex.exec(diffLines[idx]);
    if (!m) return { ok: false, error: `invalid hunk header at line ${idx}` };

    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] ? parseInt(m[2], 10) : 1;
    const newCount = m[4] ? parseInt(m[4], 10) : 1;
    const oldIdx = oldCount === 0 ? oldStart : oldStart - 1;

    if (oldIdx < 0 || oldIdx > srcLines.length)
      return { ok: false, error: `hunk ${hunkNum} starts at invalid line ${oldStart}` };
    if (hunkNum > 1 && oldIdx < prevEnd)
      return { ok: false, error: `hunk ${hunkNum} overlaps with previous hunk` };

    let opIdx = idx + 1;
    let oldCnt = 0;
    let newCnt = 0;
    const ops: Op[] = [];

    while (opIdx < diffLines.length && !diffLines[opIdx].startsWith("@@")) {
      const line = diffLines[opIdx];
      const p = line[0];
      const c = line.slice(1);

      if (line === "") {
        ops.push({ type: "context", line: "" });
        oldCnt++;
        newCnt++;
      } else if (p === " ") {
        ops.push({ type: "context", line: c });
        oldCnt++;
        newCnt++;
      } else if (p === "-") {
        ops.push({ type: "remove", line: c });
        oldCnt++;
      } else if (p === "+") {
        ops.push({ type: "add", line: c });
        newCnt++;
      } else if (p === "\\") {
      } else {
        return { ok: false, error: `invalid hunk body line in hunk ${hunkNum}: ${line}` };
      }
      opIdx++;
    }

    if (oldCnt !== oldCount || newCnt !== newCount)
      return {
        ok: false,
        error: `hunk ${hunkNum}: line counts do not match header`,
      };

    let srcOff = 0;
    const lines: string[] = [];
    const adjustedOldIdx = oldIdx + offset;

    for (const op of ops) {
      if (op.type !== "add") {
        const si = adjustedOldIdx + srcOff;
        if (si >= result.length)
          return { ok: false, error: `hunk ${hunkNum} does not apply at line ${oldStart + srcOff}` };
        if (result[si] !== op.line) {
          const t1 = op.line.length > 80 ? op.line.slice(0, 80) : op.line;
          const t2 = result[si].length > 80 ? result[si].slice(0, 80) : result[si];
          return {
            ok: false,
            error: `hunk ${hunkNum} does not apply at line ${oldStart + srcOff}: expected "${t1}" but found "${t2}"`,
          };
        }
        if (op.type === "context") lines.push(op.line);
        srcOff++;
      } else {
        lines.push(op.line);
      }
    }

    result.splice(adjustedOldIdx, oldCount, ...lines);
    offset += lines.length - oldCount;
    prevEnd = oldIdx + oldCount;
    idx = opIdx;
  }

  let res = result.join("\n");
  if (hasTrailNewline) res += "\n";
  return { ok: true, text: res };
}
