/**
 * How agents ask a person for something (browser-safe). Appended to every PiB
 * skill after the company memory section (`withFrontmatter`), and backed by
 * the Cockpit's `ask-owner` tool: the issue goes to the owner, the ask shows
 * in the Cockpit's "Waiting on you" and the daily brief, and the owner's reply
 * on the issue hands it back to the agent and wakes it.
 */
import { COMPANY_OS_SKILL_KEY } from "./team.js";

export const ASK_OWNER_TOOL = "partnersinbiz.cockpit:ask-owner";

export const ASKING_HEADING = "## Asking a person";

export const ASKING_SECTION = `${ASKING_HEADING}

- Ask only for **money, legal, one-time grants** (a login consent, a key, a DNS record) or **real judgement**. Anything else: decide, do it and say what you did.
- Outward work (posts, emails, invoices, quotes, launches) goes through its module's request or approval tool, not a question.
- Otherwise call \`${ASK_OWNER_TOOL}\` once per issue: the exact question, the options with your recommendation first, why it matters, and a link plus steps for anything they must do. It reaches the owner in the Cockpit's "Waiting on you" and the daily brief; their reply comes back on the issue and wakes you.
- Never ask in a plain comment or an @-mention, and never assign issues to people yourself. While you wait, do the parts that don't depend on the answer.
`;

/** Appends the asking section once. */
export function withAskingSection(body: string): string {
  if (body.includes(ASKING_HEADING)) return body;
  return `${body.trimEnd()}\n\n${ASKING_SECTION}`;
}

/** Skill key and slug of the company operating manual every PiB agent carries (a Cockpit managed skill). */
export const COMPANY_OS_SKILL = { key: COMPANY_OS_SKILL_KEY, slug: "pib-company-os" } as const;

/** One line for a hire's AGENTS.md next to the memory line. */
export const COMPANY_OS_INSTRUCTION =
  `Company operating manual: read the \`${COMPANY_OS_SKILL.slug}\` skill before your first task in a session and whenever work crosses modules. Ask a person only for money, legal, one-time grants or judgement, with \`${ASK_OWNER_TOOL}\` or the module's approval tool.`;
