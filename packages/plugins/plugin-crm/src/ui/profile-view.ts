/**
 * The client profile as the page sees it, and which of its fields are missing
 * (pure: no React, tested without a browser).
 */

export interface ClientProfileView {
  brandVoice: string | null;
  audience: string | null;
  services: string[];
  /** What was written as a service but maps to none, kept as text. */
  servicesOther?: string[];
  website: string | null;
  bookingLink: string | null;
  bannedWords: string[];
  toneNotes: string | null;
  logoKey?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  accentColor?: string | null;
  fonts?: string[];
  toneExamples?: string[];
  scopeTemplateRef?: string | null;
  termsRef?: string | null;
  humanOwned?: string[];
  updatedAt?: string | null;
}

export const PROFILE_LABELS: Array<{ key: keyof ClientProfileView; label: string }> = [
  { key: "brandVoice", label: "Brand voice" },
  { key: "audience", label: "Audience" },
  { key: "services", label: "Services they buy" },
  { key: "website", label: "Website" },
  { key: "bookingLink", label: "Booking link" },
  { key: "bannedWords", label: "Banned words" },
  { key: "toneNotes", label: "Tone notes" },
];

/** The brand kit and the proposal references: shown under the core fields, locked the same way. */
export const BRAND_LABELS: Array<{ key: keyof ClientProfileView; label: string }> = [
  { key: "logoKey", label: "Logo (R2 key)" },
  { key: "primaryColor", label: "Main colour" },
  { key: "secondaryColor", label: "Second colour" },
  { key: "accentColor", label: "Accent colour" },
  { key: "fonts", label: "Fonts" },
  { key: "toneExamples", label: "Tone examples" },
  { key: "scopeTemplateRef", label: "Scope template" },
  { key: "termsRef", label: "Standard terms" },
];

export function filled(profile: ClientProfileView | null, key: keyof ClientProfileView): boolean {
  const value = profile?.[key];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** The fields still empty, in display order. Services only the list does not know still count as filled in. */
export function missingFields(profile: ClientProfileView | null): string[] {
  return PROFILE_LABELS.filter((row) => !(row.key === "services" ? filled(profile, "services") || filled(profile, "servicesOther") : filled(profile, row.key))).map((row) => row.label);
}

/** Whether anything at all is filled in, the brand kit included. */
export function anyProfileField(profile: ClientProfileView | null): boolean {
  return [...PROFILE_LABELS, ...BRAND_LABELS].some((row) => filled(profile, row.key));
}

