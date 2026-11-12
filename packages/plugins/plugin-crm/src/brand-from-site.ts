/**
 * `extract-brand-from-site`: read a client's colours, fonts and logo from their website and put them in the brand kit
 * of the client profile, so every agent that makes something for the client finds them in one place.
 *
 * It fills only fields that are still empty (through `updateClientProfile`, so a field a person set is never
 * touched). Colours picked on thin evidence are returned for a person or agent to judge, not saved. The logo is
 * returned as an address: the profile keeps an R2 key, so the agent imports the image first.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { BrandExtractError, extractBrandFromSite, type BrandFindings } from "@partnersinbiz/pib-plugin-kit";
import { CrmError, type Viewer } from "./domain.js";
import { clientNameAndDomain, parseClientRef, pickProfile, updateClientProfile } from "./lookup.js";
import { refOf } from "./refs.js";
import { getClientProfile } from "./store.js";

/** A colour is saved only with this much evidence (a named variable, the theme colour, or frequent use). */
export const SAVE_SCORE = 18;

function siteAddress(value: string): string {
  const text = value.trim();
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(".")) throw new Error("no host");
    return parsed.toString();
  } catch {
    throw new CrmError(`"${value}" is not a website address. Pass url like https://acme.co.za.`);
  }
}

/** The brand fields the findings can fill, with only well-supported colours. */
export function brandPatchFrom(found: BrandFindings): Record<string, unknown> {
  const strong = (hex: string | null): string | null => {
    if (!hex) return null;
    const color = found.colors.find((c) => c.hex === hex);
    return color && (color.score >= SAVE_SCORE || color.role) ? hex : null;
  };
  const patch: Record<string, unknown> = {};
  const primary = strong(found.primaryColor);
  if (primary) patch.primaryColor = primary;
  // A second and third colour only beside a first one.
  if (primary && strong(found.secondaryColor)) patch.secondaryColor = found.secondaryColor;
  if (primary && strong(found.accentColor)) patch.accentColor = found.accentColor;
  if (found.fonts.length) patch.fonts = found.fonts;
  return patch;
}

/** Own work (no client): read the site and return what was found. The Cockpit's company profile holds own work's brand kit. */
async function readForOwnWork(ctx: PluginContext, params: Record<string, unknown>) {
  const given = typeof params.url === "string" && params.url.trim() ? params.url : null;
  if (!given) throw new CrmError("Pass client (company:<id> or contact:<id>), or url to read our own website.");
  let found: BrandFindings;
  try {
    found = await extractBrandFromSite(ctx, siteAddress(given));
  } catch (error) {
    if (error instanceof BrandExtractError) throw new CrmError(error.message);
    throw error;
  }
  const patch = brandPatchFrom(found);
  return {
    client: "own",
    site: found.url,
    found: foundOut(found),
    applied: [],
    /** What to send to the Cockpit's `update-company-profile` (it fills empty fields only). */
    forCompanyProfile: {
      ...(patch.primaryColor ? { primaryColor: patch.primaryColor } : {}),
      ...(patch.secondaryColor ? { secondaryColor: patch.secondaryColor } : {}),
      ...(patch.accentColor ? { accentColor: patch.accentColor } : {}),
      ...(found.fonts.length ? { fonts: found.fonts.join(", ") } : {}),
      ...(found.logoUrl?.startsWith("https://") ? { logoUrl: found.logoUrl } : {}),
    },
    notes: found.notes,
    next: [
      "Own work: nothing was saved. Save `forCompanyProfile` with partnersinbiz.cockpit:update-company-profile (it fills empty fields only), after you checked the colours and the logo against the site.",
      "Write tagline and visualStyle there too, from the site's own words and look (`backgroundColor` and `textColor` are the page's paper and ink: name them in visualStyle).",
    ],
  };
}

function foundOut(found: BrandFindings) {
  return {
    primaryColor: found.primaryColor,
    secondaryColor: found.secondaryColor,
    accentColor: found.accentColor,
    colors: found.colors.map((c) => ({ hex: c.hex, score: c.score, evidence: c.evidence.slice(0, 3).join("; ") })),
    /** The page's own paper and ink: part of the look (say them in the visual style), not brand colours. */
    backgroundColor: found.backgroundColor,
    textColor: found.textColor,
    fonts: found.fonts,
    /** Loaded by the page, but no rule that matches its markup uses them: not saved. */
    fontsDeclared: found.fontsDeclared,
    logoUrl: found.logoUrl,
    logoCandidates: found.logoCandidates,
    /** The share image: usually a photo or banner. Never the logo. */
    shareImage: found.shareImage,
    generator: found.generator,
    siteName: found.siteName,
    title: found.title,
    description: found.description,
    headings: found.headings,
  };
}

export async function extractBrandFromSiteTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  if (params.client === undefined || params.client === null || params.client === "" || params.client === "own") return readForOwnWork(ctx, params);
  const client = parseClientRef(params.client);
  const { name, domain } = await clientNameAndDomain(ctx, viewer, client);
  const record = await getClientProfile(ctx, viewer.companyId, client.kind, client.id);
  const profile = record ? pickProfile(record) : null;
  const given = typeof params.url === "string" && params.url.trim() ? params.url : null;
  const site = given ?? profile?.website ?? domain;
  if (!site) throw new CrmError(`No website is known for ${name}. Pass url, or save it first with update-client-profile (website).`);
  let found: BrandFindings;
  try {
    found = await extractBrandFromSite(ctx, siteAddress(site));
  } catch (error) {
    if (error instanceof BrandExtractError) throw new CrmError(error.message);
    throw error;
  }
  const candidate = brandPatchFrom(found);
  if (!profile?.website) candidate.website = found.url;
  const filled = (key: string): boolean => {
    const value = profile ? (profile as unknown as Record<string, unknown>)[key] : null;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  };
  const kept = Object.keys(candidate).filter(filled);
  const patch = Object.fromEntries(Object.entries(candidate).filter(([key]) => !filled(key)));
  const apply = params.apply !== false;
  const saved = apply && Object.keys(patch).length ? await updateClientProfile(ctx, viewer, { client: params.client, ...patch }, source) : null;
  const next: string[] = [];
  if (found.logoUrl && !profile?.logoKey) {
    next.push(`Logo: check ${found.logoUrl} is the real logo, import it with partnersinbiz.social:import-media-from-url for this client, then save its storage key with update-client-profile (logoKey).`);
  }
  if (!profile?.brandVoice || !(profile.toneExamples ?? []).length) {
    next.push("Voice: write brandVoice (1-3 sentences) and 2-8 toneExamples from the site's own words (title, description and headings below, and its pages), then save them with update-client-profile.");
  }
  if (!candidate.primaryColor) next.push("Colours: none had enough evidence to save. Look at the site (a screenshot) and save the real ones with update-client-profile; `colors` lists what was seen.");
  else next.push("Check the saved colours against the site once (the button and the logo show the real ones): a shared theme or a plugin can put another colour on many elements.");
  return {
    client: refOf(client.kind, client.id),
    name,
    site: found.url,
    found: foundOut(found),
    applied: saved ? saved.changed : [],
    refused: saved ? saved.refused : [],
    /** Found on the site but the profile already has a value: left as it is. */
    kept,
    ...(apply ? {} : { wouldApply: Object.keys(patch) }),
    notes: found.notes,
    next,
  };
}
