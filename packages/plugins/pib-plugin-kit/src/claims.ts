/**
 * Claim patterns shared by the plugins. Pure data, no behaviour: each plugin decides what a hit means.
 * Ads warns the Reviewer (AD_POLICY_CLAIMS); SEO checks the sentence against the client's approved facts (CLAIM_TERMS).
 */

/** Claims an ad platform's policy treats as misleading or unsubstantiated. A hit is for the Reviewer, not an automatic refusal. */
export const AD_POLICY_CLAIMS: Array<{ rule: string; pattern: RegExp; hint: string }> = [
  { rule: "guarantee", pattern: /\b(guarantee[ds]?|guaranteed)\b/i, hint: "A guarantee needs proof and terms the page states. Remove it, or have the client confirm it." },
  { rule: "risk_free", pattern: /\b(risk[- ]free|no[- ]risk|zero risk)\b/i, hint: "No ad can promise no risk." },
  { rule: "superlative", pattern: /(?:^|\s)(#1|no\.?\s?1|number\s(?:one|1)|best in|world'?s best|the best)\b/i, hint: "A ranking claim needs a source the ad can show." },
  { rule: "absolute_pct", pattern: /\b100\s?%\s?(safe|effective|free|guaranteed|natural|results?)\b/i, hint: "Absolute claims are rejected by ad policy." },
  { rule: "miracle", pattern: /\b(miracle|instant(?:ly)? (?:results?|cure|relief)|cure[sd]?\b|get rich)/i, hint: "Health and wealth cure claims are rejected by ad policy." },
  { rule: "before_after", pattern: /\bbefore\s?(?:and|&|\/)\s?after\b/i, hint: "Before-and-after images and claims are restricted on Meta." },
  { rule: "personal_attribute", pattern: /\b(are you|do you have|did you)\s+(diabetic|depressed|anxious|overweight|obese|bankrupt|in debt|gay|pregnant|disabled|unemployed|sick)/i, hint: "Ads may not imply they know a personal attribute (health, finances, identity). Rephrase to describe the offer, not the person." },
  { rule: "urgency_caps", pattern: /(!{3,}|\b[A-Z]{4,}(?:\s+[A-Z]{4,}){2,})/, hint: "Shouting (capitals, repeated exclamation marks) lowers approval and trust." },
];

/** Words that usually mean a promise or a rule about the business. Generic across clients; each sheet adds its own "avoid". */
export const CLAIM_TERMS: Array<{ re: RegExp; why: string }> = [
  { re: /\breserve(d)?\b/i, why: "a reserve price" },
  { re: /\b(is|are|will be|becomes?|goes? to) (yours|the winner|your)\b/i, why: "who gets or owns an item" },
  { re: /\bguarantee(d|s)?\b/i, why: "a guarantee" },
  { re: /\binspect(ed|ion|s)?\b/i, why: "inspection of goods" },
  { re: /\bverif(y|ied|ies|ication)\b/i, why: "verification of sellers or goods" },
  { re: /\b100\s*%/i, why: "an absolute percentage" },
  // Naming a licence page is fine; saying who needs one, who may hold one or what is allowed is a legal claim.
  { re: /(?=.*\blicen[cs](e|ed|es|ing)\b)(?=.*\b(need|needs|needed|require|requires|required|must|only|valid|without|cannot|can't|allowed|permitted|not|no)\b)/i, why: "licensing rules" },
  { re: /\bFICA\b/i, why: "FICA / legal compliance" },
  { re: /\brefund(s|ed)?\b/i, why: "refunds" },
  { re: /\bwarrant(y|ies)\b/i, why: "a warranty" },
  { re: /\bfree (delivery|shipping|courier)\b/i, why: "free delivery" },
  { re: /\b(lowest|best|cheapest) price/i, why: "a price promise" },
  { re: /\bno (hidden )?(fees?|charges?|commission)\b/i, why: "fees" },
  { re: /\bcommission\b/i, why: "commission" },
  { re: /\bwithin \d+ (working |business )?(hours?|days?)\b/i, why: "a time commitment" },
  { re: /\b(legal(ly)?|lawful(ly)?|compliant|compliance)\b/i, why: "legal compliance" },
  // Training and education: which courses carry which status is the client's own statement, never the copywriter's.
  { re: /\b(accredit(ed|ation)|QCTO|SAQA|SETA|NQF|(nationally|internationally) recogni[sz]ed|certified)\b/i, why: "accreditation or certification" },
  { re: /\b(at your own pace|self[- ]paced|at any time|anytime|24\/7|study (anywhere|when you))\b/i, why: "when and how a course can be studied" },
  { re: /\b(job placement|guaranteed (job|employment)|get(ting)? a job|you will (earn|get hired))\b/i, why: "a job or income outcome" },
];
