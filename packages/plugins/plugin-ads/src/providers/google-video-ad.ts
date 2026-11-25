/**
 * Google media and video ads, PAR-6697 (the stubs left on Google after G1 and G2).
 *
 * Facts from Google's docs (checked 2026-11-12, API v26):
 * - Images and videos are assets made with `assets:mutate` (AssetService) before an ad can use them. An image asset carries its bytes
 *   (`imageAsset.data`, base64 in JSON). A video asset is a YouTube video (`youtubeVideoAsset.youtubeVideoId`, the 11-character id):
 *   Google Ads cannot take a video file, so a video must be on YouTube first (unlisted is fine).
 * - There is no standalone creative and no ad set with its own budget: the copy and media live in the ad itself (`adGroupAds:mutate`),
 *   the ad group is the nearest thing to an ad set, and the budget is the campaign's. So `createAdSet` and `createAdCreative` refuse
 *   with the Google way instead, and `createAd` on Google makes a Demand Gen video responsive ad in an ad group (the YouTube-only
 *   ad group G2 creates with the video campaign).
 * - Demand Gen video responsive ad (Google Ads Help "video assets specifications ... for Demand Gen"): 1-5 YouTube videos, a square
 *   logo image (required), a business name (required, 25 characters), headlines (40), long headlines (90), descriptions (90), up to
 *   5 of each, and one final URL (2,048).
 */
import { AdsError, requiredString } from "../domain.js";
import { finalUrlOf, textList } from "../rsa.js";

export const VIDEO_AD_LIMITS = { maxVideos: 5, maxTexts: 5, headlineChars: 40, longHeadlineChars: 90, descriptionChars: 90, businessNameChars: 25 } as const;

export interface GoogleVideoAd {
  /** YouTube video asset resource names from upload-ad-media (`customers/<id>/assets/<id>`). */
  videoAssets: string[];
  /** The square logo image asset resource name from upload-ad-media. */
  logoImageAsset: string;
  businessName: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  finalUrl: string;
}

const ASSET = /^customers\/\d+\/assets\/\d+$/;
/** The 11-character id in youtube.com/watch?v=, youtu.be/, youtube.com/shorts/ or /embed/ links. */
const YOUTUBE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/;

/** The YouTube video id in a YouTube link. Anything else is refused: Google Ads takes YouTube videos only. */
export function youtubeVideoId(url: string): string {
  const id = YOUTUBE.exec(url.trim())?.[1];
  if (!id) throw new AdsError("Google ads use YouTube videos only: upload the video to YouTube (unlisted is fine) and pass its youtube.com or youtu.be link as videoUrl.", "unsupported_on_platform");
  return id;
}

/** JPEG, PNG or GIF by their first bytes: the image types Google takes for ad images and logos. */
export function imageMimeOf(bytes: Buffer): "IMAGE_JPEG" | "IMAGE_PNG" | "IMAGE_GIF" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "IMAGE_JPEG";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "IMAGE_PNG";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "IMAGE_GIF";
  throw new AdsError("Google takes JPEG, PNG or GIF images only; this file is none of those.");
}

function assetName(raw: string, label: string, customer: string | null): string {
  const name = raw.trim();
  if (!ASSET.test(name)) throw new AdsError(`${label} must be an asset from upload-ad-media (customers/<id>/assets/<id>), not "${name}"`);
  if (customer !== null && name.split("/")[1] !== customer) throw new AdsError(`${label} ${name} belongs to another Google Ads account`);
  return name;
}

/**
 * Checks a Google create_ad proposal (and again in the provider before anything is sent). `customer` is the account's customer id
 * (digits) when known, so an asset from another account is refused before Google sees it.
 */
export function videoAdFrom(input: Record<string, unknown>, customer: string | null = null): GoogleVideoAd {
  const rawVideos = Array.isArray(input.videoAssets) ? input.videoAssets : [];
  if (rawVideos.length < 1 || rawVideos.length > VIDEO_AD_LIMITS.maxVideos) throw new AdsError(`videoAssets must hold 1 to ${VIDEO_AD_LIMITS.maxVideos} YouTube video assets from upload-ad-media, not ${rawVideos.length}`);
  const videoAssets = [...new Set(rawVideos.map((v) => assetName(String(v ?? ""), "videoAssets", customer)))];
  const logoImageAsset = assetName(requiredString(input, "logoImageAsset", 200), "logoImageAsset", customer);
  const businessName = requiredString(input, "businessName", 200).trim();
  if (businessName.length < 1 || [...businessName].length > VIDEO_AD_LIMITS.businessNameChars) throw new AdsError(`businessName must be 1 to ${VIDEO_AD_LIMITS.businessNameChars} characters`);
  const { maxTexts } = VIDEO_AD_LIMITS;
  return {
    videoAssets,
    logoImageAsset,
    businessName,
    headlines: textList(input.headlines, "headline", 1, maxTexts, VIDEO_AD_LIMITS.headlineChars),
    longHeadlines: textList(input.longHeadlines, "long headline", 1, maxTexts, VIDEO_AD_LIMITS.longHeadlineChars),
    descriptions: textList(input.descriptions, "description", 1, maxTexts, VIDEO_AD_LIMITS.descriptionChars),
    finalUrl: finalUrlOf(input.finalUrl),
  };
}

/** A stored payload's video ad back as proposal input, so a revision keeps what it does not name. */
export function videoAdInput(videoAd: unknown): Record<string, unknown> {
  if (!videoAd || typeof videoAd !== "object") return {};
  const v = videoAd as GoogleVideoAd;
  return { videoAssets: v.videoAssets, logoImageAsset: v.logoImageAsset, businessName: v.businessName, headlines: v.headlines, longHeadlines: v.longHeadlines, descriptions: v.descriptions, finalUrl: v.finalUrl };
}

/** The `adGroupAds:mutate` create: a PAUSED Demand Gen video responsive ad in the ad group. */
export function videoAdOperation(customer: string, adGroupId: string, name: string, ad: GoogleVideoAd): Record<string, unknown> {
  const texts = (list: string[]) => list.map((text) => ({ text }));
  return {
    create: {
      adGroup: `customers/${customer}/adGroups/${adGroupId}`,
      // Always paused: switching it on is a separate approved change, and Google reviews it first.
      status: "PAUSED",
      ad: {
        name,
        finalUrls: [ad.finalUrl],
        demandGenVideoResponsiveAd: {
          videos: ad.videoAssets.map((asset) => ({ asset })),
          logoImages: [{ asset: ad.logoImageAsset }],
          businessName: { text: ad.businessName },
          headlines: texts(ad.headlines),
          longHeadlines: texts(ad.longHeadlines),
          descriptions: texts(ad.descriptions),
        },
      },
    },
  };
}
