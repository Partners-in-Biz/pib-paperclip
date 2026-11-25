/**
 * Give to agent from the hook board (Peet, 17 Nov 2026): a person asks the Social agent for more of a hook, body or ask,
 * a change to it, or a plan for the whole board, from the host's New Task popup. The worker writes the prefill from the
 * board's own numbers (our data, not received content), with a next step that fits the part's verdict; the person edits
 * it in the popup and the host creates the task. Nothing is recorded on our side.
 */
import { clientPrefix, formatClientParam } from "./clients.js";
import type { PartRow, Part } from "./hook-board.js";
import { MIN_REACH } from "./hook-board.js";

export type GivePart = Part | "board";

const PART_LABEL: Record<Part, { one: string; tag: string }> = {
  hook: { one: "hook", tag: "hook:" },
  body: { one: "body", tag: "body:" },
  cta: { one: "ask", tag: "cta:" },
};

export const GIVE_NOTE_PLACEHOLDER = "(Write here what you want: more of it, a change, or stop. The suggestion below is only a start.)";

interface Board {
  periodDays: number;
  published: number;
  tagged: number;
  reach: number;
  control: { hook: string | null; body: string | null; cta: string | null };
  hooks: PartRow[];
  bodies: PartRow[];
  ctas: PartRow[];
  notes: string[];
}

/** What to do next with one part, by its verdict. Pure. */
export function nextStep(part: Part, row: PartRow, control: Board["control"]): string {
  const one = PART_LABEL[part].one;
  const tag = `\`${PART_LABEL[part].tag}${row.name}\``;
  switch (row.verdict) {
    case "double down":
      return `Make two new posts with this ${one} (${tag}), each with a different look or setting${part === "hook" && control.body ? `, on the control body \`body:${control.body}\`` : ""}${part !== "cta" && control.cta ? ` and ask \`cta:${control.cta}\`` : ""}. Tag them the same.`;
    case "drop":
      return `Stop using this ${one}. Write two replacements that try a different angle and tag them with new names.`;
    case "keep testing":
      return `Use this ${one} on one or two more posts so it gets enough people to rank, tagged ${tag}.`;
    default:
      return `It has reached ${row.reach} of the ${MIN_REACH} people a ${one} needs before it is ranked. Get it reach first: say it again as a short video (15 to 40 seconds, 9:16) tagged ${tag}, and reply where the audience already talks.`;
  }
}

function rowLine(part: Part, row: PartRow): string {
  return `- ${PART_LABEL[part].one} \`${row.name}\`: ${row.posts} post${row.posts === 1 ? "" : "s"}, ${row.reach} reached, ${row.rate === null ? "no rate yet" : `${row.rate} acted per 100`}, verdict **${row.verdict}**`;
}

/**
 * The New Task prefill for one part (`part` + `name`) or the whole board (`part: "board"`). Throws when the part is not
 * on the board. Pure.
 */
export function hookGiveText(board: Board, part: GivePart, name: string | null, scope: { client_kind?: string | null; client_ref?: string | null; client_name?: string | null }, scopeParam: string | null, pagePath: string | null): { title: string; description: string } {
  const prefix = clientPrefix(scope);
  const where = scopeParam ? `client \`${scopeParam}\`` : "own work (no client)";
  const head = [GIVE_NOTE_PLACEHOLDER, "", `**From the hook board** (${where}, last ${board.periodDays} days: ${board.tagged} of ${board.published} published posts tagged, ${board.reach} people reached).`, ""];
  const tail = [
    "",
    "Read the board yourself first (`hook-board`) and the posts behind it (`get-post`). Draft with `create-post` and tag every post `hook:`, `body:` and `cta:`; then `validate-post` and `request-review`. Nothing goes out without approval.",
    pagePath ? `Open the board: [Social → Growth](${pagePath})` : "Open the board on the Social page → Growth.",
  ];
  if (part === "board") {
    const lines = [
      ...board.hooks.map((r) => rowLine("hook", r)),
      ...board.bodies.map((r) => rowLine("body", r)),
      ...board.ctas.map((r) => rowLine("cta", r)),
    ];
    const control = [board.control.hook ? `hook \`${board.control.hook}\`` : null, board.control.body ? `body \`${board.control.body}\`` : null, board.control.cta ? `ask \`${board.control.cta}\`` : null].filter(Boolean);
    return {
      title: `${prefix}Social: act on the hook board`,
      description: [
        ...head,
        ...(lines.length ? lines : ["- No tagged posts yet."]),
        "",
        `Control so far: ${control.length ? control.join(", ") : "none (nothing has enough reach to rank)"}.`,
        ...(board.notes.length ? ["", "What the board says:", ...board.notes.map((n) => `- ${n}`)] : []),
        "",
        "Suggested: make two posts for every part marked double down, none for a part marked drop, and short video for the parts with too little reach.",
        ...tail,
      ].join("\n"),
    };
  }
  const rows = part === "hook" ? board.hooks : part === "body" ? board.bodies : board.ctas;
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`The ${PART_LABEL[part].one} "${name ?? ""}" is not on the hook board for this period.`);
  return {
    title: `${prefix}Social: more or change ${PART_LABEL[part].one} "${row.name}"`,
    description: [
      ...head,
      rowLine(part, row),
      `- Posts: ${row.postIds.map((id) => `\`${id.slice(0, 8)}\``).join(", ") || "none"}`,
      "",
      `Suggested: ${nextStep(part, row, board.control)}`,
      ...tail,
    ].join("\n"),
  };
}

export function scopeParamOf(scope: { client_kind?: string | null; client_ref?: string | null }): string | null {
  return scope.client_ref ? formatClientParam({ kind: (scope.client_kind as "company" | "contact") ?? "company", id: scope.client_ref }) : null;
}
