/**
 * Decision rights: who decides a sign-off. Pure, no node imports.
 *
 * The owner set the rule (11 Nov 2026): one named agent seat decides each
 * class of sign-off, and only six hard stops reach the owner. This file reads
 * a question and says which of the two it is. The seats themselves are company
 * settings (`decisionRights` in the Cockpit settings, agent ids, never names):
 * the code only knows the classes. A company with no seats set keeps the old
 * behaviour, where every question goes to the owner.
 *
 * The reading is by words, so it can be wrong. It is built to fail towards the
 * safe side: a hard-stop word sends the question to the owner, and a question
 * with no class goes to the seat for "anything else", who passes a real hard
 * stop up (that seat's own questions are never routed back to itself).
 */

/** The six hard stops, in the owner's order. Only these reach the owner. */
export const HARD_STOPS = {
  "client-production": { n: 1, label: "client production", text: "a client's site or app going to main or live, or a production database change" },
  money: { n: 2, label: "money", text: "a spend over R500, a new subscription, or any quote, invoice or price" },
  logins: { n: 3, label: "logins and devices", text: "a login, key or account only the owner holds, or the owner's hands on a device" },
  legal: { n: 4, label: "legal or a client commitment", text: "legal text, or a message that commits the company to a client" },
  "store-release": { n: 5, label: "public store release", text: "a new app version going public in a store" },
  "data-delete": { n: 6, label: "deleting data", text: "deleting client or production data with no way back" },
} as const;
export type HardStopKey = keyof typeof HARD_STOPS;

/** The sign-off classes of the decision-rights table. `other` is "anything else". */
export const DECISION_CLASSES = ["release", "planTechnical", "planBusiness", "access", "social", "storeListing", "seo", "root", "instructions", "other"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export const DECISION_CLASS_LABEL: Record<DecisionClass, string> = {
  release: "release of our own products",
  planTechnical: "technical plan",
  planBusiness: "business plan",
  access: "access that already exists",
  social: "social post for our own brands",
  storeListing: "store listing text and pictures",
  seo: "SEO page refresh or internal links",
  root: "root on the server or a board-only setting",
  instructions: "instruction or skill file change",
  other: "question of fact, approach or who does what",
};

/** Spend at or under this (rand) is not a money hard stop. */
export const MONEY_LIMIT_ZAR = 500;

export interface DecisionRights {
  /** True when at least one seat is set and the company did not switch routing off. */
  enabled: boolean;
  /** Agent id per class. A class with no seat falls back to `other`. */
  seats: Partial<Record<DecisionClass, string>>;
  /** Names of the company's own products (a release that names none of them is treated as a client's). */
  ownProducts: string[];
}

export const NO_DECISION_RIGHTS: DecisionRights = { enabled: false, seats: {}, ownProducts: [] };

/** Reads `decisionRights` from the Cockpit settings. Anything malformed is dropped, never guessed. */
export function parseDecisionRights(config: unknown): DecisionRights {
  const root = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).decisionRights : null;
  if (!root || typeof root !== "object" || Array.isArray(root)) return NO_DECISION_RIGHTS;
  const row = root as Record<string, unknown>;
  const seats: Partial<Record<DecisionClass, string>> = {};
  const rawSeats = row.seats && typeof row.seats === "object" && !Array.isArray(row.seats) ? (row.seats as Record<string, unknown>) : {};
  for (const key of DECISION_CLASSES) {
    const value = rawSeats[key];
    if (typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value.trim())) seats[key] = value.trim();
  }
  const ownProducts = Array.isArray(row.ownProducts)
    ? [...new Set(row.ownProducts.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter((p) => p.length >= 2 && p.length <= 60))].slice(0, 40)
    : [];
  return { enabled: row.enabled !== false && Object.keys(seats).length > 0, seats, ownProducts };
}

/** What the reading looks at. */
export interface AskFacts {
  /** The ask kind: decision, grant, money, legal or info. Host cards pass "decision". */
  kind: string;
  /** Everything the asker wrote: question, options, why and steps. */
  text: string;
  /** The issue's title: read only for which product the question is about, never for its class (a title like "Ship the pricing page" says nothing about the question). */
  context?: string | null;
  /** Set when the question is about a client (`company:<id>`). */
  clientRef?: string | null;
  /** True when a yes also runs an effect: that always needs a person. */
  hasEffect?: boolean;
  /** The hard stop the asker named (`hardStop` on ask-owner). Trusted when the words name none. */
  declaredHardStop?: HardStopKey | null;
}

/** One string from the parts of a question, for the reading. */
export function askText(parts: { question?: string | null; options?: string[] | null; why?: string | null; steps?: string[] | null }): string {
  return [parts.question, ...(parts.options ?? []), parts.why, ...(parts.steps ?? [])]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n")
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "");
}

const RE = {
  dataDeleteVerb: /\b(delet(e|es|ed|ing|ion)|purg(e|es|ing)|wip(e|es|ing)|eras(e|es|ing)|truncat(e|es|ing)|destroy(s|ing)?)\b|\bdrop(s|ping)? (the |a |all )?(\w+ )?(tables?|databases?|db|collections?|buckets?|data|records)\b/i,
  dataDeleteThing: /\b(data|databases?|db|tables?|records?|rows|backups?|production|clients?|customers?|users?|accounts?|mailbox(es)?|media|uploads?|buckets?)\b/i,
  dataDeleteHarmless: /\b(branch(es)?|worktrees?|drafts?|test data|canary|scratch|cache|temp(orary)?|node_modules|logs?)\b/i,
  dataDeleteReal: /\b(clients?|customers?|production|backups?)\b/i,
  store: /\b(app store|play store|google play|play console|app store connect|testflight|store listing)\b/i,
  storeRelease: /\b(releas(e|es|ed|ing)|submit(s|ted|ting)?|go(es|ing)? (public|live)|production track|roll(s|ed|ing)? ?out|new (app )?version|binary|build \d+)\b/i,
  storeListing: /\b(listings?|subtitle|keywords?|descriptions?|screenshots?|metadata|promo(tional)? text|locali[sz]ation|new language|app name)\b/i,
  root: /\b(as root|root (access|on|shell|login)|needs root|sudo|systemctl|pib-root|board[- ]only|board (setting|token|key)|instance (setting|admin)|on the vps)\b|\/root\//i,
  accessExists:
    /\b(attach|bind|binding|bound|give|add)\b.{0,60}\b(stored|existing|company) secret\b|\bsecret\b.{0,40}\b(is |are )?(already )?(stored|saved|held)\b|\b(plugin )?tool (grant|access|permission)s?\b|\bgrant\b.{0,40}\btools?\b|\baccess that already exists\b/i,
  accessNever: /\b(payments?|bank(ing)?|credit card|card details|personal|owner'?s)\b/i,
  moneyStrict: /\b(subscriptions?|subscribe|recurring|per month|monthly fee|annual fee|invoices?|quot(e|es|ation|ations)|pric(e|es|ing)|refunds?|bank|credit card)\b|\/\s?(month|mo|year)\b/i,
  moneyQuoteOfPost: /\bquot(e|es|ing)\b (an? |the |this |that )?(x |linkedin |social )?(post|tweet|article)\b/i,
  zar: /\bR\s?(\d[\d\s,]*(?:\.\d+)?)(\s?(k|thousand))?/gi,
  foreign: /(\$|€|£)\s?\d|\b(USD|EUR|GBP)\s?\d|\b\d[\d,.]*\s?(USD|EUR|GBP|dollars?|euros?|pounds?)\b/i,
  /** Words for a login, key or the owner's own device. The store consoles are named apart (`storeConsole`): a listing change mentions them too. */
  login:
    /\b(passwords?|passcode|passphrase|log ?ins?|sign ?ins?|sign-ins?|2fa|mfa|otp|one[- ]time (code|pin)|verification code|sms code|authenticator|api keys?|secret keys?|private keys?|keystores?|certificates?|credentials?|oauth|consent screen|re-?auth\w*|tokens?|secrets?|dns records?|nameservers?|registrar|licen[cs]e[- ]tester|sandbox tester|by hand|only you|your hands)\b|\bplease (tap|click|press|paste|share|install|upload|run|open|sign)\b|\b(have|did) you\b|\baccess (is )?(needed|required)\b|\bneeds? access\b|\bgive (us|me|the agent) access\b|\bshare (the |a )?(drive )?folder\b|\b(on )?your (phone|iphone|ipad|android|device|mac|macbook|laptop|browser|keychain|apple id|google account)\b|\b(re)?connect\b.{0,40}\b(account|page|profile|channel)\b/i,
  storeConsole: /\b(testflight|app store connect|play console)\b/i,
  /** Where a release lands when it is production. */
  releaseTarget: /\b(main|master|production|prod|live|sites?|websites?|theme|shop|domain)\b/i,
  legal: /\b(legal|contracts?|terms (of (service|use)|and conditions)|t&cs?|privacy (policy|notice)|popia|gdpr|nda|agreements?|liabilit\w+|indemnit\w+|disclaimer|consent (text|wording|form)|e-?sign\w*|signature)\b/i,
  clientSend:
    /\btier [bc]\b|\bsend\b.{0,60}\b(follow-ups?|emails?|messages?|repl(y|ies)|drafts?|whatsapp|sms|newsletter)\b|\bsend\b.{0,40}\bto (the |a |our )?(client|customer|lead|prospect)s?\b|\bemail\b.{0,30}\b(the |a |our )?(client|customer|lead)s?\b|\breply to (the |a |our )?(client|customer|lead)\b|\b(proposal|quote|report|statement)s? (to|for) (the |a |our )?clients?\b|\bclient (emails?|sends?|messages?|reports?)\b|\bcommit(s|ting)? (us|the company)\b|\bpromis(e|es|ed|ing)\b.{0,30}\bclients?\b/i,
  seo: /\b(seo|page refresh(es)?|content refresh(es)?|refresh(ed|ing)? (the )?pages?|internal[- ]link\w*|meta (titles?|descriptions?)|title tags?|on-page)\b/i,
  seoNotThis: /\b(theme|plugin|new pages?|template|merge|pull request|pr ?#?\d+|deploy\w*|database|email)\b/i,
  social: /\b(social (posts?|content|calendar)|posts? (for|on|to) (linkedin|x|twitter|instagram|facebook|tiktok|youtube|threads)|linkedin posts?|tweets?|captions?|carousels?|reels?|content calendar)\b/i,
  plan: /\b(plans?|task breakdown|work breakdown|roadmap|implementation plan|specs?)\b/i,
  planAsk: /\b(sign[- ]?off|approv\w+|accept\w*|go[- ]ahead|review)\b/i,
  planBusiness: /\b(business|marketing|sales|growth|campaigns?|go-to-market|gtm|revenue|commercial|brand|content plan|outreach)\b/i,
  planClientPromise: /\b(scope|promis\w+|commitment)\b/i,
  instructions: /\b(agents\.md|skill\.md|soul\.md|instructions? (files?|change|update|edit)|skill (files?|text|change|update)|system prompt|operating manual)\b/i,
  release: /\b(merg(e|es|ed|ing)|deploy(s|ed|ing|ment)?|releas(e|es|ed|ing)|promot(e|es|ed|ing)|ship(s|ped|ping)?|go(es|ing)? live|cut ?over|roll(s|ed|ing)? ?out|to main|into main|production)\b/i,
  client: /\bclient('s|s)?\b/i,
} as const;

/** The largest rand amount named, or null when none is. `R 6,860.00` is 6860, `R1.5k` is 1500. */
export function largestRand(text: string): number | null {
  let max: number | null = null;
  for (const match of text.matchAll(RE.zar)) {
    const digits = (match[1] ?? "").replace(/[\s,]/g, "");
    const value = Number.parseFloat(digits) * (match[2] ? 1000 : 1);
    if (Number.isFinite(value)) max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function namesOwnProduct(facts: AskFacts, ownProducts: readonly string[]): boolean {
  const lower = `${facts.text}\n${facts.context ?? ""}`.toLowerCase();
  return ownProducts.some((product) => lower.includes(product.toLowerCase()));
}

function moneyStop(facts: AskFacts): boolean {
  const text = facts.text;
  const strict = RE.moneyStrict.test(text.replace(RE.moneyQuoteOfPost, ""));
  if (strict || RE.foreign.test(text)) return true;
  const rand = largestRand(text);
  if (rand !== null) return rand > MONEY_LIMIT_ZAR;
  // A money question that names no amount cannot be shown to be small.
  return facts.kind === "money";
}

/** Which hard stop a question is, or its class when it is none. A hard stop the asker named stands when the words name none. */
export function classify(facts: AskFacts, ownProducts: readonly string[] = []): { hardStop: HardStopKey | null; decisionClass: DecisionClass } {
  const read = readWords(facts, ownProducts);
  if (!read.hardStop && facts.declaredHardStop) return { hardStop: facts.declaredHardStop, decisionClass: "other" };
  return read;
}

function readWords(facts: AskFacts, ownProducts: readonly string[]): { hardStop: HardStopKey | null; decisionClass: DecisionClass } {
  const text = facts.text;
  const stop = (hardStop: HardStopKey) => ({ hardStop, decisionClass: "other" as DecisionClass });
  const cls = (decisionClass: DecisionClass) => ({ hardStop: null, decisionClass });
  const aboutClient = !!facts.clientRef || RE.client.test(text);

  if (facts.kind === "legal") return stop("legal");
  if (RE.dataDeleteVerb.test(text) && RE.dataDeleteThing.test(text) && (!RE.dataDeleteHarmless.test(text) || RE.dataDeleteReal.test(text))) return stop("data-delete");
  if (RE.store.test(text)) {
    // Listing text and pictures only: no release, and nothing that needs the owner's login or device.
    if (RE.storeListing.test(text) && !RE.storeRelease.test(text) && !RE.login.test(text)) return facts.clientRef ? stop("client-production") : cls("storeListing");
    if (RE.storeRelease.test(text)) return stop("store-release");
  }
  if (moneyStop(facts)) return stop("money");
  // Access the company already holds, and root work, are named before the login words they contain.
  if (RE.root.test(text)) return cls("root");
  if (RE.accessExists.test(text)) return RE.accessNever.test(text) ? stop("logins") : cls("access");
  if (facts.kind === "grant" || facts.hasEffect) return stop("logins");
  if (RE.login.test(text) || RE.storeConsole.test(text)) return stop("logins");
  if (RE.legal.test(text) || RE.clientSend.test(text)) return stop("legal");
  if (RE.seo.test(text) && !RE.seoNotThis.test(text)) return cls("seo");
  // A post under a client's name needs the client's written yes: it stays with the owner.
  if (RE.social.test(text)) return aboutClient && !namesOwnProduct(facts, ownProducts) ? stop("client-production") : cls("social");
  if (RE.plan.test(text) && RE.planAsk.test(text)) {
    if (aboutClient && RE.planClientPromise.test(text)) return stop("legal");
    return cls(RE.planBusiness.test(text) ? "planBusiness" : "planTechnical");
  }
  if (RE.instructions.test(text)) return cls("instructions");
  if (RE.release.test(text)) {
    // A release that names one of our own products, and no client, is ours. One that goes to main, live or a site and names none is treated as a client's.
    if (!facts.clientRef && namesOwnProduct(facts, ownProducts)) return cls("release");
    if (aboutClient || RE.releaseTarget.test(text)) return stop("client-production");
    return cls("release");
  }
  return cls("other");
}

export type AskRoute =
  /** Goes to the owner: a hard stop, a company with no seats, or the last seat passing it up. */
  | { to: "owner"; hardStop: HardStopKey | null; decisionClass: DecisionClass }
  /** Goes to the seat that decides the class. `passedUp` when the class's own decider asked. */
  | { to: "seat"; hardStop: null; decisionClass: DecisionClass; seatAgentId: string; passedUp: boolean };

/**
 * Where a question goes at the moment it is raised.
 * - A hard stop goes to the owner.
 * - Anything else goes to the seat for its class (`other` when the class has no seat).
 * - A decider asking about its own class passes it to the `other` seat.
 * - The `other` seat's own questions go to the owner: that seat is the last one before the owner.
 */
export function routeAsk(facts: AskFacts, rights: DecisionRights, askerAgentId: string | null): AskRoute {
  const { hardStop, decisionClass } = classify(facts, rights.ownProducts);
  const owner: AskRoute = { to: "owner", hardStop, decisionClass };
  if (hardStop || !rights.enabled) return owner;
  const last = rights.seats.other ?? null;
  const seat = rights.seats[decisionClass] ?? last;
  if (!seat) return owner;
  if (askerAgentId && askerAgentId === seat) {
    if (!last || seat === last) return owner;
    return { to: "seat", hardStop: null, decisionClass, seatAgentId: last, passedUp: true };
  }
  return { to: "seat", hardStop: null, decisionClass, seatAgentId: seat, passedUp: false };
}

/** Hours after which a question that is not a hard stop applies its recommended answer. */
export const DEFAULT_APPLY_HOURS = 24;

/**
 * The answer that applies by itself when nobody replies: the recommended option
 * (the first option when none is marked, since the card shows the first as
 * recommended). Null when the question must wait for a person: a hard stop, a
 * money, legal or grant question, an effect, or no options.
 */
export function defaultAnswer(input: { kind: string; options: readonly string[]; recommended: string | null; hasEffect: boolean; hardStop: HardStopKey | null }): string | null {
  if (input.hardStop || input.hasEffect) return null;
  if (input.kind !== "decision" && input.kind !== "info") return null;
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (options.length === 0) return null;
  const recommended = input.recommended?.trim() || options[0]!;
  return options.includes(recommended) ? recommended : null;
}
