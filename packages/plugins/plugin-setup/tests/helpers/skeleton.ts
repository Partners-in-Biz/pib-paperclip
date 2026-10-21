/** Skeleton template structure validation helpers. */

export const SKELETON_H2S = [
  "Identity and mission",
  "Reports to and escalation",
  "Owns / never does",
  "Triggers and inputs",
  "Procedure",
  "Hand-offs",
  "Evidence and done",
  "Tools and skills",
  "When stuck",
  "Subagents",
] as const;

/** Asserts that a rendered text contains exactly the skeleton H2s in the correct order. Throws on mismatch. */
export function assertSkeleton(renderedText: string): void {
  const lines = renderedText.split("\n");
  const inFence = new Set<number>();
  let fenceStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      if (fenceStart >= 0) {
        for (let j = fenceStart; j <= i; j++) inFence.add(j);
        fenceStart = -1;
      } else {
        fenceStart = i;
      }
    }
  }

  const headings: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence.has(i)) continue;
    const match = /^## (.+?)\s*$/.exec(lines[i]!);
    if (match) headings.push(match[1]!);
  }

  const expected: readonly string[] = SKELETON_H2S;
  const problems: string[] = [];

  if (headings.length !== expected.length) {
    problems.push(`expected ${expected.length} H2 headings, found ${headings.length}`);
  }

  for (let i = 0; i < Math.max(headings.length, expected.length); i++) {
    if (i >= expected.length) {
      problems.push(`extra heading at position ${i}: "${headings[i]}"`);
    } else if (i >= headings.length) {
      problems.push(`missing heading at position ${i}: "${expected[i]}"`);
    } else if (headings[i] !== expected[i]) {
      if (expected.includes(headings[i]!)) {
        problems.push(`heading at position ${i} out of order: "${headings[i]}" (should be "${expected[i]}")`);
      } else {
        problems.push(`unexpected heading at position ${i}: "${headings[i]}" (expected "${expected[i]}")`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Skeleton structure invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}
