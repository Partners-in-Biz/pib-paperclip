/**
 * The plain-words help page for each sellable module, one copy for every plugin. The words are for the
 * company's owner, not for a developer: what the module does, what the agents do in it, what the owner does.
 *
 * Text never names the platform operator or a person. Where a company or owner has to appear it uses the
 * placeholders `{{company}}`, `{{owner}}` and `{{ownerTitle}}` (same names as the skill text placeholders);
 * `fillHelp` swaps them and falls back to neutral words when the page does not know the value.
 */

export interface HelpPageContent {
  /** Plugin key, as in the manifest id (`partnersinbiz.crm`). */
  pluginKey: string;
  /** The plugin's page `routePath` (no slash); the help page is that route with `?help=1`. */
  route: string;
  /** Short module name, e.g. "CRM". */
  title: string;
  /** One or two sentences: what the module is for. */
  intro: string;
  /** What the module does. */
  does: readonly string[];
  /** What the agents do in it. */
  agents: readonly string[];
  /** What the owner does, and what waits for the owner. */
  owner: readonly string[];
  /**
   * Tools of the plugin the text relies on. A contract test checks each one is registered by the plugin, so
   * a tool that is renamed or removed fails the test and the text gets rechecked. Setup has none (its
   * claims are about the module switches, not tools).
   */
  tools: readonly string[];
}

export interface HelpVars {
  company?: string | null;
  owner?: string | null;
  ownerTitle?: string | null;
}

/** Words used when the page does not know the company or owner. */
export const HELP_FALLBACKS = { company: "your company", owner: "the owner", ownerTitle: "owner" } as const;

export const HELP_PLACEHOLDERS = ["company", "owner", "ownerTitle"] as const;

export function fillHelp(text: string, vars: HelpVars = {}): string {
  return text.replace(/\{\{(company|owner|ownerTitle)\}\}/g, (_match, key: keyof typeof HELP_FALLBACKS) => {
    const value = vars[key]?.trim();
    return value ? value : HELP_FALLBACKS[key];
  });
}

export const HELP_PAGES: readonly HelpPageContent[] = [
  {
    pluginKey: "partnersinbiz.crm",
    route: "crm",
    title: "CRM",
    intro:
      "The CRM is {{company}}'s address book and sales board. Every person and business you deal with, and every sale in progress, lives here, so nothing depends on someone's memory.",
    does: [
      "Keeps contacts and companies in one place, with a timeline of every call, email and note.",
      "Shows deals as a board, from first enquiry to won or lost, with a forecast of what is likely to close.",
      "Collects enquiries from your website forms and adds them as new leads.",
      "Sends documents for e-signature and keeps the signed copy with the client.",
      "Tracks support cases and keeps client reports and website checks next to the client they belong to.",
    ],
    agents: [
      "Add new leads, tidy duplicates and keep contact details up to date.",
      "Log calls, emails and meetings on the right contact so the timeline stays complete.",
      "Move deals forward when something happens and flag the ones that have gone quiet.",
      "Draft client reports and open support cases when a client reports a problem.",
    ],
    owner: [
      "Look at the deal board to see where each sale stands.",
      "Check documents before they go out for signature.",
      "Tell the agents who your important clients are and what they care about.",
    ],
    tools: ["find-records", "create-contact", "create-deal", "move-deal", "send-for-signature", "open-support-case", "build-client-report", "create-lead-endpoint", "find-duplicates", "log-activity"],
  },
  {
    pluginKey: "partnersinbiz.mailbox",
    route: "mailbox",
    title: "Mailbox",
    intro:
      "The Mailbox is {{company}}'s shared inbox. Incoming mail is read, sorted and answered here, and every reply is a draft first.",
    does: [
      "Brings in mail from the company's addresses and groups it into conversations.",
      "Sorts each message by what it needs: a reply, a payment question, a sales enquiry, or just information.",
      "Holds email templates so replies sound the same every time.",
      "Checks that the sending address is set up properly which helps your mail reach the inbox.",
      "Links a conversation to the client it is about.",
    ],
    agents: [
      "Read new mail, sort it and mark what is urgent.",
      "Write reply drafts in {{company}}'s voice using the templates.",
      "Attach the conversation to the right client in the CRM.",
      "Warn when a sending address or domain needs attention.",
    ],
    owner: [
      "Read the drafts waiting in the Mailbox and approve, change or reject them.",
      "Drafts wait for you; agents only send where they have been given permission.",
      "Correct the sorting if an agent put a message in the wrong group.",
    ],
    tools: ["list-inbox", "create-draft", "send-draft", "create-email-template", "check-sender-domain", "map-client-mail", "correct-triage"],
  },
  {
    pluginKey: "partnersinbiz.social",
    route: "social",
    title: "Social",
    intro:
      "Social plans, writes, schedules and publishes {{company}}'s posts on the connected accounts, and collects the replies that come back.",
    does: [
      "Connects the company's social accounts and shows them in one place.",
      "Keeps a calendar of drafted, scheduled and published posts.",
      "Stores pictures and video in a media library and reuses templates.",
      "Brings comments and messages into one inbox.",
      "Reports how each post and account performed.",
    ],
    agents: [
      "Draft posts and pick or request the pictures that go with them.",
      "Schedule posts and publish them once approved.",
      "Suggest replies to comments and messages.",
      "Review what worked and propose what to try next.",
    ],
    owner: [
      "Connect each account once; you stay in control of the login.",
      "Approve posts before they go out, if the approval rule is switched on for your company.",
      "Answer anything an agent marks as needing a personal reply.",
    ],
    tools: ["connect-account", "schedule-post", "list-inbox", "create-media-asset", "post-analytics", "create-post"],
  },
  {
    pluginKey: "partnersinbiz.seo",
    route: "seo",
    title: "SEO",
    intro:
      "SEO works to get {{company}}'s website found on Google and in AI answers. It finds what to fix, does the safe work itself and asks you before anything bigger.",
    does: [
      "Tracks the keywords that matter and where the site ranks for them.",
      "Checks the website for problems such as missing titles, broken pages and slow pages.",
      "Plans the work as a sprint of small tasks and shows progress against it.",
      "Connects to Google Search Console and Analytics to show real visits and searches.",
      "Keeps a weekly summary of what changed and what comes next.",
    ],
    agents: [
      "Run the checks, record what they find and fix what is safe to fix.",
      "Write or improve page content and submit changes for review.",
      "Request indexing for new pages and keep the sitemap in order.",
      "Add anything that needs a person to the list called Needs you.",
    ],
    owner: [
      "Connect Search Console and Analytics when asked.",
      "Check the facts about the business that the agents have written down, and correct them.",
      "Open Needs you and clear what is waiting there.",
      "Approve larger changes before they reach the live site.",
    ],
    tools: ["discover-keywords", "run-audit-snapshot", "create-sprint", "gsc-pull", "request-indexing", "needs-you", "post-digest", "list-keywords"],
  },
  {
    pluginKey: "partnersinbiz.campaigns",
    route: "campaigns",
    title: "Campaigns",
    intro:
      "Campaigns sends planned sequences of emails to a chosen group of people, and shows who opened, clicked and replied.",
    does: [
      "Builds a campaign as a series of steps with waits in between.",
      "Sends from the sender names you set up, and stops for anyone who replies or unsubscribes.",
      "Keeps a list of addresses and phone numbers that must not be contacted.",
      "Runs simple A/B tests of two versions and shows which did better.",
      "Reports opens, clicks and replies per campaign and per step.",
    ],
    agents: [
      "Draft the steps and write the emails.",
      "Run a pre-launch check on the list, the sender and the wording.",
      "Pause a campaign that is not working and suggest a better version.",
      "Log replies against the right contact in the CRM.",
    ],
    owner: [
      "Approve a campaign when an agent asks for approval to launch it.",
      "Choose the sender name people will see.",
      "Decide which test version wins when an agent proposes one.",
    ],
    tools: ["create-campaign", "preflight-campaign", "request-campaign-approval", "set-sender-identity", "suppress-address", "create-ab-variant", "campaign-stats"],
  },
  {
    pluginKey: "partnersinbiz.billing",
    route: "billing",
    title: "Billing",
    intro:
      "Billing handles what {{company}} charges and what it is owed: quotes, invoices, payments and reminders.",
    does: [
      "Creates quotes and turns an accepted quote into an invoice.",
      "Keeps invoices, credit notes, recurring invoices and payment links in one place.",
      "Records payments, including proof of payment sent by a client, and shows what is still owed.",
      "Tracks time that can be billed, and the bills and expenses {{company}} has to pay.",
      "Can send polite reminders for overdue invoices when you switch that on.",
    ],
    agents: [
      "Prepare quotes and invoices as drafts from the deal or the time recorded.",
      "Check incoming payments against open invoices.",
      "Draft payment reminders and follow-ups.",
      "Keep the figures in the reports up to date.",
    ],
    owner: [
      "Review each draft before it is sent to a client. Automatic reminders go out only if you have switched them on.",
      "Approve bills before they are paid.",
    ],
    tools: ["create-quote", "convert-quote", "create-invoice", "record-payment", "request-reminder-send", "log-time", "create-bill", "create-payment-link"],
  },
  {
    pluginKey: "partnersinbiz.cockpit",
    route: "cockpit",
    title: "Cockpit",
    intro:
      "The Cockpit is the owner's overview of {{company}}: what happened today, what the agents are working on and what is waiting for you.",
    does: [
      "Shows a short brief each day: what was done, what is stuck and what is next.",
      "Lists everything that waits for the {{ownerTitle}}, in one place.",
      "Holds the company's goals and shows progress toward them.",
      "Keeps the company profile and the memory the agents share.",
      "Shows warnings when something is not working, such as a failed task or a connection that needs attention.",
    ],
    agents: [
      "Write the daily brief and keep the goals up to date.",
      "Record what they learned so the next job starts from it.",
      "Ask {{owner}} a question when they cannot go on without an answer.",
      "Raise a warning when a check fails.",
    ],
    owner: [
      "Read the daily brief.",
      "Answer what is waiting for you; the agents keep going on other work in the meantime.",
      "Set or change the goals.",
      "Keep the company profile correct, because the agents rely on it.",
    ],
    tools: ["post-daily-brief", "goal-set", "waiting-on-owner", "company-profile", "health-issues", "ask-owner"],
  },
  {
    pluginKey: "partnersinbiz.setup",
    route: "setup",
    title: "Setup",
    intro:
      "Setup is where {{company}} switches modules on, connects what each one needs and sees what is still left to do before everything works.",
    does: [
      "Lists each module and says whether it is on, off or not part of your plan.",
      "Shows a checklist of the steps still to do for each module.",
      "Shows what each module still needs before it works.",
    ],
    agents: [
      "Work through the checklist items they can do themselves.",
      "Mark a step done once it has been checked, not just attempted.",
      "Tell {{owner}} exactly what is missing when a step needs a login or a decision.",
    ],
    owner: [
      "Switch on the modules you want to use.",
      "Do the steps only you can do, such as signing in to an account.",
    ],
    tools: [],
  },
];

export function helpPageFor(pluginKey: string | null | undefined): HelpPageContent | null {
  return HELP_PAGES.find((page) => page.pluginKey === pluginKey) ?? null;
}

/** The in-app path of a module's help page (no company prefix; pass it to the host's `linkProps`). */
export function helpTo(page: Pick<HelpPageContent, "route">, search?: string | null): string {
  const params = new URLSearchParams(search ?? "");
  params.set("help", "1");
  return `/${page.route}?${params.toString()}`;
}

/** The module's own page, where the help page's back link goes. */
export function helpBackTo(page: Pick<HelpPageContent, "route">, search?: string | null): string {
  const params = new URLSearchParams(search ?? "");
  params.delete("help");
  const text = params.toString();
  return text ? `/${page.route}?${text}` : `/${page.route}`;
}

/** True when the address asks for the help page (`?help=1`). */
export function isHelpRequested(search: string | null | undefined): boolean {
  return new URLSearchParams(search ?? "").get("help") === "1";
}

/** Every piece of text on a help page, for tests that scan the words. */
export function helpTexts(page: HelpPageContent): string[] {
  return [page.title, page.intro, ...page.does, ...page.agents, ...page.owner];
}
