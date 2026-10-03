/**
 * The managed way for developer and tester agents to look at a page (audit Q5-5).
 * Penny's guide told agents they cannot open a browser while Chromium sat installed,
 * so most UI issues closed with "not checked". The command is `scripts/pib-shot.cjs`
 * in this plugin, installed by the deploy at `PIB_SHOT_PATH`; this is the text that
 * tells agents when it is mandatory and how to use it. It ships as a reference file
 * of the company operating manual (every PiB role carries it) and of the
 * Acceptance skill, from this one source, so the two never disagree.
 */
export const PIB_SHOT_PATH = "/home/paperclip/pib-tools/pib-shot";
export const SCREENSHOT_REFERENCE_PATH = "references/screenshots.md";

export const SCREENSHOT_REFERENCE = `# Looking at a page: pib-shot

You can open a browser. \`${PIB_SHOT_PATH}\` takes a headless screenshot with the Chrome already installed on this server, in about a second. "Not checked: no browser" is not a way to close UI work.

## When you must
- **You changed anything a person sees**: a page, a component, styles, layout, copy on a page, an email or document template, a client preview. Before you close the issue or hand it to review, look at it at desktop and at phone width.
- **You review or test UI work** (Code Reviewer, tester, Acceptance): look at it yourself. Do not trust the author's description.
- A change nobody sees (an API, a migration, a script) needs no picture: say so in one line.

## How
\`${PIB_SHOT_PATH} <url> [--viewport desktop|mobile|tablet|WxH] [--out file.png] [--expect "text"]... [--json]\`
- The page must be reachable from this machine: a public staging or preview address, or your dev server on localhost (start it detached, cap commands with \`timeout 60\`, never leave a server running). A page behind a login cannot be photographed: use a public preview or a fixture page, and say what you could not check.
- \`--expect "Pricing"\` also reads the rendered page and fails (exit 4) when that text is not on it: use it for the heading, the button or the value you changed.
- \`--json\` prints one line (path, size, sha256): paste it in your comment as the evidence. The default folder is /tmp/pib-shots; attach the PNGs to the issue.
- Exit codes: 0 done; 2 wrong call; 3 no browser; 4 an expected text is missing; 5 no usable picture (the page did not load or is blank: the picture is thrown away, and an error page is never proof).
- A full-length page: \`--viewport 1280x3000\` (any size from 200 to 4000 a side).

## What to write
In your closing comment: the address, the viewports, the file names and what you saw ("heading and plan table render; nothing overflows at 390 px"), and what you could not check.

## Never
- Never put a login or token in the address (the command refuses it).
- Never attach a page that shows one client's personal data to another client's issue.
`;
