/**
 * The 90-day plan variants by business type. Pure and browser-safe (the SEO
 * page shows the plan names and the task titles).
 *
 * PiB's clients are mostly South African service businesses, so the plan a
 * sprint follows depends on what the business is:
 * - local: a local service business (guest house, clinic, biokineticist,
 *   club, trades): Google Business Profile, one name/address/phone everywhere,
 *   SA directories and citations, reviews, service and area pages;
 * - professional: professional services (law firm, accountant, consultancy):
 *   expertise pages, case studies, professional bodies and directories;
 * - ecommerce: an online shop: category and product pages, Google Merchant
 *   Center, buying guides, shopping and review sites;
 * - saas: software: the original Outrank-90 launch plan (G2, Product Hunt,
 *   comparison pages).
 *
 * A sprint stores its plan as `template_id` (`outrank-90` is the software
 * plan, so every sprint created before the variants keeps working as it is).
 * Tasks with the same template key mean the same work in every plan (and share
 * one playbook); a plan can give a shared task its own title.
 */
import { GEO_TASKS } from "./geo.js";
import {
  DEFAULT_DIRECTORIES,
  OUTRANK_90,
  TEMPLATE_ID,
  TEMPLATE_VERSION,
  phaseForWeek,
  type DirectorySeed,
  type SeoTaskTemplate,
  type SeoTemplate,
} from "./outrank-90.js";

export const BUSINESS_TYPES = ["local", "professional", "ecommerce", "saas"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export interface PlanVariant extends SeoTemplate {
  businessType: BusinessType;
  /** What people call the business type. */
  label: string;
  /** One line: what the plan focuses on and who it is for. */
  summary: string;
  /** Directories and citations seeded on the Backlinks tab. */
  sources: DirectorySeed[];
}

/** The plan's `template_id`. The software plan keeps the original id. */
export const PLAN_TEMPLATE_IDS: Record<BusinessType, string> = {
  saas: TEMPLATE_ID,
  local: `${TEMPLATE_ID}-local`,
  professional: `${TEMPLATE_ID}-professional`,
  ecommerce: `${TEMPLATE_ID}-ecommerce`,
};

type Extra = Omit<SeoTaskTemplate, "phase" | "playbook" | "owner"> & { playbook?: string; owner?: SeoTaskTemplate["owner"] };

function extra(input: Extra): SeoTaskTemplate {
  return { owner: "agent", ...input, phase: phaseForWeek(input.week) as SeoTaskTemplate["phase"], playbook: input.playbook ?? input.templateKey };
}

/** Tasks that only some plans have (their playbooks live in playbooks.ts under the same key). */
const EXTRA_TASKS: SeoTaskTemplate[] = [
  extra({ templateKey: "w0-gbp-claim", week: 0, focus: "Local presence", title: "Claim and verify the Google Business Profile", taskType: "gbp-claim", autopilotEligible: true }),
  extra({ templateKey: "w0-nap", week: 0, focus: "Local presence", title: "Use one exact business name, address and phone number everywhere", taskType: "nap-fix", autopilotEligible: true }),
  extra({ templateKey: "w0-merchant-center", week: 0, focus: "Shopping", title: "Set up Google Merchant Center free listings (product feed)", taskType: "merchant-center", autopilotEligible: true }),
  extra({ templateKey: "w3-service-pages", week: 3, focus: "Core Pages", title: "Write one page per main service", taskType: "page-write", autopilotEligible: true }),
  extra({ templateKey: "w3-contact-page", week: 3, focus: "Core Pages", title: "Make the contact page complete: map, hours, phone, booking", taskType: "page-write", autopilotEligible: true }),
  extra({ templateKey: "w3-team-page", week: 3, focus: "Core Pages", title: "Show real expertise: team bios with qualifications and registrations", taskType: "page-write", autopilotEligible: true }),
  extra({ templateKey: "w3-category-pages", week: 3, focus: "Core Pages", title: "Write the top 5 category pages (unique intro, FAQ, links)", taskType: "page-write", autopilotEligible: true }),
  extra({ templateKey: "w3-product-pages", week: 3, focus: "Core Pages", title: "Rewrite the top 10 product pages (unique descriptions, specs, photos)", taskType: "page-write", autopilotEligible: true }),
  extra({ templateKey: "w4-gbp-complete", week: 4, focus: "Local presence", title: "Complete the Google Business Profile: services, hours, photos, booking link", taskType: "gbp-complete", autopilotEligible: true }),
  extra({ templateKey: "w4-case-studies", week: 4, focus: "Core Pages", title: "Publish 2 case studies or client stories (with permission)", taskType: "page-write", autopilotEligible: false }),
  extra({ templateKey: "w4-product-reviews", week: 4, focus: "Core Pages", title: "Show product reviews on product pages (and in the schema)", taskType: "reviews-display", autopilotEligible: true }),
  extra({ templateKey: "w6-reviews", week: 6, focus: "Reviews", title: "Start asking happy customers for Google reviews", taskType: "review-requests", autopilotEligible: false }),
  extra({ templateKey: "w8-area-pages", week: 8, focus: "Local pages", title: "Launch a page for each main town or area served (unique content)", taskType: "area-pages", autopilotEligible: false }),
  extra({ templateKey: "w8-industry-listings", week: 8, focus: "Backlinks", title: "Get listed with the industry's own bodies and booking sites", taskType: "industry-listing", autopilotEligible: true }),
  extra({ templateKey: "w8-collection-pages", week: 8, focus: "Shop pages", title: "Launch collection pages for real searches (by use, brand, price)", taskType: "collection-pages", autopilotEligible: false }),
  extra({ templateKey: "w9-partner-links", week: 9, focus: "Backlinks", title: "Ask 3 partners for a link", taskType: "link-trade-dm", autopilotEligible: false }),
  extra({ templateKey: "w10-local-press", week: 10, focus: "Backlinks", title: "Pitch a local news site or community blog a story", taskType: "guest-post-pitch", autopilotEligible: false }),
];

const CATALOG = new Map<string, SeoTaskTemplate>([...OUTRANK_90.tasks, ...EXTRA_TASKS, ...GEO_TASKS].map((t) => [t.templateKey, t]));

type PlanItem = string | [key: string, title: string];

function pick(list: PlanItem[]): SeoTaskTemplate[] {
  return list.map((item) => {
    const [key, title] = typeof item === "string" ? [item, null] : item;
    const base = CATALOG.get(key);
    if (!base) throw new Error(`Unknown plan task ${key}`);
    return title ? { ...base, title } : { ...base };
  });
}

/** Week 0 and 1 work every plan shares (the schema and noindex titles differ per plan). */
function foundation(schemaTitle: string, noindexTitle: string): PlanItem[] {
  return [
    "w0-meta-tags",
    ["w0-schema", schemaTitle],
    "w0-gsc-verify",
    "w0-sitemap-submit",
    "w0-gsc-request-index",
    "w0-bing-verify",
    "w0-cross-link",
    "w1-robots-check",
    "w1-gsc-index-check",
    "w1-pagespeed-check",
    "w1-cwv-check",
    "w1-canonical-check",
    "w1-alt-text",
    ["w1-noindex", noindexTitle],
  ];
}

const KEYWORD_TAIL: PlanItem[] = ["w2-keyword-bucket", "w2-keyword-prioritize", "w2-keyword-record"];
/** The GEO (AI search) workstream: the same eight tasks in every plan (templates/geo.ts). */
const GEO: PlanItem[] = GEO_TASKS.map((t) => t.templateKey);
const AUTHORITY: PlanItem[] = ["w11-stuck-pages", "w11-update-stuck"];
const DAY_90: PlanItem[] = ["w13-audit-metrics", "w13-audit-report", "w13-audit-announce"];

/** The order tasks appear in (by week, then as listed): the seeding and the plan grid follow it. */
function byWeek(tasks: SeoTaskTemplate[]): SeoTaskTemplate[] {
  return tasks.map((task, index) => ({ task, index })).sort((a, b) => a.task.week - b.task.week || a.index - b.index).map((x) => x.task);
}

const GBP: DirectorySeed = { source: "Google Business Profile", domain: "business.google.com", dr: null, type: "citation" };
const BING_PLACES: DirectorySeed = { source: "Bing Places", domain: "bingplaces.com", dr: null, type: "citation" };
const APPLE: DirectorySeed = { source: "Apple Business Connect", domain: "businessconnect.apple.com", dr: null, type: "citation" };
const FACEBOOK: DirectorySeed = { source: "Facebook business page", domain: "facebook.com", dr: null, type: "citation" };
const HELLOPETER: DirectorySeed = { source: "Hellopeter (reviews)", domain: "hellopeter.com", dr: null, type: "citation" };
const YELLOW_PAGES: DirectorySeed = { source: "Yellow Pages South Africa", domain: "yellowpages.co.za", dr: null };
const BRABYS: DirectorySeed = { source: "Brabys", domain: "brabys.com", dr: null };
const CYLEX: DirectorySeed = { source: "Cylex South Africa", domain: "cylex.net.za", dr: null };
const SA_YELLOW: DirectorySeed = { source: "saYellow", domain: "sayellow.com", dr: null };
const HOTFROG: DirectorySeed = { source: "Hotfrog South Africa", domain: "hotfrog.co.za", dr: null };
const SNUPIT: DirectorySeed = { source: "Snupit", domain: "snupit.co.za", dr: null };
const YELL: DirectorySeed = { source: "Yell South Africa", domain: "yell.co.za", dr: null };
const SHOWME: DirectorySeed = { source: "Showme", domain: "showme.co.za", dr: null };

/** Local service business: Google Business Profile, maps, SA directories and a review site. */
export const LOCAL_SOURCES: DirectorySeed[] = [
  GBP,
  BING_PLACES,
  APPLE,
  FACEBOOK,
  HELLOPETER,
  { source: "Foursquare", domain: "foursquare.com", dr: null, type: "citation" },
  YELLOW_PAGES,
  YELL,
  BRABYS,
  CYLEX,
  SNUPIT,
  SA_YELLOW,
  HOTFROG,
  SHOWME,
  { source: "YelloSA", domain: "yellosa.co.za", dr: null },
];

/** Professional services: the local basics plus LinkedIn, B2B and professional directories. */
export const PROFESSIONAL_SOURCES: DirectorySeed[] = [
  GBP,
  BING_PLACES,
  APPLE,
  { source: "LinkedIn company page", domain: "linkedin.com", dr: null, type: "citation" },
  FACEBOOK,
  HELLOPETER,
  YELLOW_PAGES,
  YELL,
  BRABYS,
  CYLEX,
  SA_YELLOW,
  HOTFROG,
  SNUPIT,
  { source: "Kompass South Africa (B2B)", domain: "za.kompass.com", dr: null },
  { source: "Clutch (agencies and consultancies)", domain: "clutch.co", dr: null },
];

/** Online shop: Google Shopping, a price comparison site, review sites and the main directories. */
export const ECOMMERCE_SOURCES: DirectorySeed[] = [
  { source: "Google Merchant Center (free listings)", domain: "merchants.google.com", dr: null, type: "citation" },
  { source: "PriceCheck (price comparison)", domain: "pricecheck.co.za", dr: null },
  HELLOPETER,
  { source: "Trustpilot", domain: "trustpilot.com", dr: null, type: "citation" },
  GBP,
  FACEBOOK,
  { source: "Pinterest business", domain: "pinterest.com", dr: null, type: "citation" },
  YELLOW_PAGES,
  BRABYS,
  CYLEX,
  SA_YELLOW,
  HOTFROG,
  SHOWME,
];

const SAAS_PLAN: PlanVariant = {
  ...OUTRANK_90,
  tasks: byWeek([...OUTRANK_90.tasks, ...GEO_TASKS]),
  businessType: "saas",
  label: "Software (SaaS)",
  summary: "The software launch plan: comparison and feature pages, G2, Product Hunt and SaaS directories.",
  sources: DEFAULT_DIRECTORIES,
};

const LOCAL_PLAN: PlanVariant = {
  id: PLAN_TEMPLATE_IDS.local,
  version: TEMPLATE_VERSION,
  name: "90-day local SEO plan",
  businessType: "local",
  label: "Local service business",
  summary: "Google Business Profile, South African directories, reviews, and a page per service and area. For guest houses, clinics, clubs and trades.",
  sources: LOCAL_SOURCES,
  tasks: byWeek(pick([
    ...foundation("Add LocalBusiness + FAQ schema (structured data)", "Keep thank-you, admin and duplicate pages out of Google (noindex)"),
    "w0-gbp-claim",
    "w0-nap",
    ["w2-keyword-discover", "Pick 20–30 local keywords (service + town, 'near me')"],
    ...KEYWORD_TAIL,
    ["w3-homepage", "Write the home page around the main service and town"],
    "w3-service-pages",
    "w3-contact-page",
    ["w4-faq-schema", "Add FAQ schema to the core pages"],
    "w4-internal-links",
    "w4-gbp-complete",
    ["w5-post-1", "Publish post 1: a local guide or FAQ customers search for"],
    "w5-repurpose-1",
    ["w6-post-2", "Publish post 2: answer a common customer question"],
    "w6-repurpose-2",
    "w6-reviews",
    ["w7-pillar", "Publish the complete guide to the main service"],
    ["w7-pillar-links", "Link every post to the guide"],
    "w8-area-pages",
    "w8-industry-listings",
    ["w9-directories", "List the business on the seeded SA directories (same name, address and phone)"],
    ["w9-partner-links", "Ask 3 local partners for a link (suppliers, venues, clubs)"],
    "w10-local-press",
    ["w10-community", "Share a helpful post in local community groups"],
    ...AUTHORITY,
    ["w12-cluster-pick", "Pick one local topic for a small cluster of posts"],
    ["w12-cluster-publish", "Publish 3–5 supporting posts around the guide, all linked"],
    ...GEO,
    ...DAY_90,
  ])),
};

const PROFESSIONAL_PLAN: PlanVariant = {
  id: PLAN_TEMPLATE_IDS.professional,
  version: TEMPLATE_VERSION,
  name: "90-day professional services SEO plan",
  businessType: "professional",
  label: "Professional services",
  summary: "Expertise pages, case studies, professional bodies and directories, and reviews. For law firms, accountants and consultancies.",
  sources: PROFESSIONAL_SOURCES,
  tasks: byWeek(pick([
    ...foundation("Add ProfessionalService + FAQ schema (structured data)", "Keep thank-you, admin and duplicate pages out of Google (noindex)"),
    "w0-gbp-claim",
    "w0-nap",
    ["w2-keyword-discover", "Pick 20–30 keywords clients search before they hire (service + city, questions)"],
    ...KEYWORD_TAIL,
    ["w3-homepage", "Write the home page around the main service and city"],
    ["w3-service-pages", "Write one page per practice area or service"],
    "w3-team-page",
    ["w4-faq-schema", "Add FAQ schema to the core pages"],
    "w4-internal-links",
    "w4-case-studies",
    ["w5-post-1", "Publish post 1: answer a question clients ask before they hire"],
    "w5-repurpose-1",
    ["w6-post-2", "Publish post 2: a plain-language guide to a common problem"],
    "w6-repurpose-2",
    ["w6-reviews", "Start asking happy clients for Google reviews"],
    ["w7-pillar", "Publish the complete guide to the main practice area"],
    ["w7-pillar-links", "Link every post to the guide"],
    ["w8-area-pages", "Launch a page for each city or region served (unique content)"],
    ["w8-industry-listings", "Get listed with professional bodies and industry directories"],
    ["w9-directories", "List the firm on the seeded business and professional directories"],
    ["w9-partner-links", "Ask 3 referral partners for a link"],
    ["w10-guest-post", "Pitch a guest article to an industry publication"],
    ["w10-community", "Answer questions where clients ask them (LinkedIn, forums)"],
    ...AUTHORITY,
    "w12-cluster-pick",
    ["w12-cluster-publish", "Publish 3–5 supporting posts around the guide, all linked"],
    ...GEO,
    ...DAY_90,
  ])),
};

const ECOMMERCE_PLAN: PlanVariant = {
  id: PLAN_TEMPLATE_IDS.ecommerce,
  version: TEMPLATE_VERSION,
  name: "90-day online shop SEO plan",
  businessType: "ecommerce",
  label: "Online shop",
  summary: "Category and product pages, Google Merchant Center, buying guides, and shopping and review sites.",
  sources: ECOMMERCE_SOURCES,
  tasks: byWeek(pick([
    ...foundation("Add Organization, Product + FAQ schema (structured data)", "Keep cart, checkout, account and filter pages out of Google (noindex)"),
    "w0-merchant-center",
    ["w2-keyword-discover", "Pick 20–30 product and category keywords people buy with"],
    ...KEYWORD_TAIL,
    ["w3-homepage", "Write the home page around the main product range"],
    "w3-category-pages",
    "w3-product-pages",
    ["w4-faq-schema", "Add FAQ and Product schema to category and product pages"],
    ["w4-internal-links", "Link categories, products and guides to each other"],
    "w4-product-reviews",
    ["w5-post-1", "Publish post 1: a buying guide for the top category"],
    "w5-repurpose-1",
    ["w6-post-2", "Publish post 2: a comparison or 'best for' guide"],
    "w6-repurpose-2",
    ["w6-reviews", "Start asking recent buyers for reviews (Google, Hellopeter)"],
    ["w7-pillar", "Publish the complete buying guide for the main category"],
    ["w7-pillar-links", "Link every guide to the buying guide"],
    "w8-collection-pages",
    ["w8-pseo-comparison", "Launch 'X vs Y' and 'alternatives' pages for top products"],
    ["w9-directories", "List the shop on the seeded shopping and review sites"],
    ["w9-partner-links", "Ask the brands and suppliers you stock for a 'where to buy' link"],
    ["w10-guest-post", "Pitch a gift guide or roundup feature to a relevant blog"],
    ["w10-community", "Share a helpful post where buyers talk (forums, groups, Reddit)"],
    ...AUTHORITY,
    "w12-cluster-pick",
    ["w12-cluster-publish", "Publish 3–5 supporting guides around the buying guide, all linked"],
    ...GEO,
    ...DAY_90,
  ])),
};

export const PLANS: Record<BusinessType, PlanVariant> = {
  local: LOCAL_PLAN,
  professional: PROFESSIONAL_PLAN,
  ecommerce: ECOMMERCE_PLAN,
  saas: SAAS_PLAN,
};

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === "string" && (BUSINESS_TYPES as readonly string[]).includes(value);
}

/** The business type a sprint's `template_id` stands for. Anything unknown is the original (software) plan. */
export function businessTypeOf(templateId: string | null | undefined): BusinessType {
  const found = (Object.keys(PLAN_TEMPLATE_IDS) as BusinessType[]).find((type) => PLAN_TEMPLATE_IDS[type] === templateId);
  return found ?? "saas";
}

export function planFor(type: BusinessType): PlanVariant {
  return PLANS[type];
}

/** The plan a sprint follows. */
export function planOf(templateId: string | null | undefined): PlanVariant {
  return PLANS[businessTypeOf(templateId)];
}

/** A template task in the sprint's plan. */
export function planTask(templateId: string | null | undefined, templateKey: string | null | undefined): SeoTaskTemplate | undefined {
  if (!templateKey) return undefined;
  return planOf(templateId).tasks.find((t) => t.templateKey === templateKey);
}

/** Every task template any plan uses, once per key (for the skill reference and the playbook checks). */
export function allPlanTasks(): SeoTaskTemplate[] {
  return [...CATALOG.values()];
}

/** Default when nobody chose: a local service business for a client, the software plan for our own sites. */
export function defaultBusinessType(forClient: boolean): BusinessType {
  return forClient ? "local" : "saas";
}
