/**
 * Photo Studio style presets, ported from the old site's lib/creative/photo-styles.ts. A preset id builds the whole
 * prompt on the server, so a caller can't send its own wording under a preset's name. Pure and client-safe: the
 * Studio page imports it too.
 */

export type PhotoPresetGroup = "edit" | "business" | "product" | "fun";

export interface PhotoPreset {
  id: string;
  group: PhotoPresetGroup;
  label: string;
  tagline: string;
  /** Best with a person, a product, or anything. */
  subject: "person" | "product" | "any";
  prompt: string;
}

/** Model and ratio a preset starts from. The page's model list must offer DEFAULT_PRESET_MODEL. */
export const DEFAULT_PRESET_MODEL = "higgsfield-ai/soul/v2/standard";
export const DEFAULT_PRESET_RATIO = "1:1";

/** Longest extra note a person or agent can add to a preset. */
export const PHOTO_NOTE_MAX = 400;

const KEEP_IDENTITY = "Keep the person clearly recognisable: same face shape, features, skin tone, hair and expression. Do not add text, logos or watermarks.";
const KEEP_PRODUCT = "Keep the product exactly as it is: same shape, colours, labels and proportions. Do not add text or watermarks.";

export const CUSTOM_EDIT_PRESET_ID = "custom-edit";

export const PHOTO_PRESETS: readonly PhotoPreset[] = [
  {
    id: CUSTOM_EDIT_PRESET_ID, group: "edit", label: "Custom edit", tagline: "Describe any change",
    subject: "any",
    prompt: "Make the image the user describes below. Keep to what they ask for and nothing else. Do not add text or watermarks unless asked.",
  },
  {
    id: "studio-headshot", group: "business", label: "Studio headshot", tagline: "LinkedIn-ready in one tap",
    subject: "person",
    prompt: `Create a professional studio headshot: head and shoulders, soft key light with gentle fill, neutral mid-grey seamless backdrop, crisp focus on the eyes, natural skin retouching, smart business attire consistent with what they wear. ${KEEP_IDENTITY}`,
  },
  {
    id: "brand-portrait", group: "business", label: "Brand portrait", tagline: "Editorial, natural light",
    subject: "person",
    prompt: `Create an editorial brand portrait for a website "About" page: warm natural window light, modern office or studio setting softly blurred behind them, shallow depth of field, confident relaxed pose, magazine-quality colour grade. ${KEEP_IDENTITY}`,
  },
  {
    id: "clean-up", group: "business", label: "Clean up & enhance", tagline: "Fix light, colour and noise",
    subject: "any",
    prompt: "Create a clean, enhanced, completely realistic photo: well-balanced exposure and white balance, detailed shadows and highlights, low noise, gentle sharpness, no dust or blemishes. Do not add text or watermarks.",
  },
  {
    id: "product-white", group: "product", label: "Product on white", tagline: "Marketplace-ready packshot",
    subject: "product",
    prompt: `Isolate the main product and place it on a pure white (#FFFFFF) seamless background as an e-commerce packshot: centred, evenly lit with soft studio lighting, subtle natural contact shadow, crisp edges, true-to-life colour. ${KEEP_PRODUCT}`,
  },
  {
    id: "product-lifestyle", group: "product", label: "Lifestyle scene", tagline: "Your product, in the real world",
    subject: "product",
    prompt: `Place the main product in an aspirational lifestyle scene that suits what it is (for example a styled kitchen counter, desk, bathroom shelf or outdoor table), with warm natural light, tasteful props and a softly blurred background that keeps the product the hero. Photorealistic advertising photography. ${KEEP_PRODUCT}`,
  },
  {
    id: "product-hero", group: "product", label: "Ad hero shot", tagline: "Dramatic light for campaigns",
    subject: "product",
    prompt: `Make a dramatic advertising hero shot of the main product: dark gradient backdrop, sculpted rim lighting, glossy reflections on a surface beneath it, a few elegant atmospheric particles, premium campaign look with space around it for a headline. ${KEEP_PRODUCT}`,
  },
  {
    id: "caricature", group: "fun", label: "Caricature", tagline: "Big smile, bold lines",
    subject: "person",
    prompt: `Create a playful, flattering digital caricature: slightly enlarged head and expressive features, clean bold outlines, bright saturated colours, warm solid background. ${KEEP_IDENTITY}`,
  },
  {
    id: "anime", group: "fun", label: "Anime", tagline: "Hand-drawn animation look",
    subject: "any",
    prompt: "Draw this in a high-quality Japanese anime film style: clean line art, cel shading, luminous skies and soft painted backgrounds, expressive eyes. Keep the composition, and keep any person recognisable (hair, clothing, expression). Do not add text or watermarks.",
  },
  {
    id: "3d-avatar", group: "fun", label: "3D avatar", tagline: "Animated film character",
    subject: "person",
    prompt: `Create a charming 3D animated film character: soft subsurface skin shading, slightly stylised proportions, big expressive eyes, cinematic lighting, simple pastel studio background. ${KEEP_IDENTITY}`,
  },
  {
    id: "watercolour", group: "fun", label: "Watercolour", tagline: "Soft painted wash",
    subject: "any",
    prompt: "Paint this as a delicate watercolour painting on textured cotton paper: loose washes, soft bleeding edges, gentle granulation, a few confident ink lines, plenty of white paper showing. Keep the composition and keep any person recognisable. Do not add text or watermarks.",
  },
  {
    id: "vintage-film", group: "fun", label: "Vintage film", tagline: "1970s analogue warmth",
    subject: "any",
    prompt: "Create a photograph that looks like a 1970s analogue film shot: warm faded colours, soft contrast, natural film grain, slight halation around highlights, gentle vignette. Keep everything in the image the same otherwise. Do not add text, dates or watermarks.",
  },
  {
    id: "pencil-sketch", group: "fun", label: "Pencil sketch", tagline: "Graphite on paper",
    subject: "any",
    prompt: "Draw this as a detailed graphite pencil sketch on off-white paper: confident contour lines, cross-hatched shading, smudged soft tones, visible paper grain. Keep the composition and keep any person recognisable. Do not add text or watermarks.",
  },
]

const PRESET_BY_ID = new Map(PHOTO_PRESETS.map((preset) => [preset.id, preset]));

export function getPhotoPreset(id: unknown): PhotoPreset | null {
  return typeof id === "string" ? (PRESET_BY_ID.get(id) ?? null) : null;
}

/** The preset's full prompt, with the optional note (trimmed, cut to PHOTO_NOTE_MAX) worked in. */
export function buildPhotoPresetPrompt(preset: PhotoPreset, note?: string): string {
  const extra = note?.trim().slice(0, PHOTO_NOTE_MAX);
  if (preset.id === CUSTOM_EDIT_PRESET_ID) {
    return [preset.prompt, `The edit: ${extra || "Improve the image subtly."}`, "Return a single image."].join("\n");
  }
  return [
    preset.prompt,
    extra ? `Extra direction from the user (follow it unless it conflicts with the rules above): ${extra}` : "",
    "Return a single image.",
  ]
    .filter(Boolean)
    .join("\n");
}
