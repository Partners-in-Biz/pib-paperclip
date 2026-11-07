/**
 * The prompt template library on the Generate page: ready-made prompts with fill-in fields, plus a company's saved ones.
 * Pure and client-safe: the page and the worker both import it.
 *
 * Written by us on the formulas the 2026 guides agree on. Images: subject, surface, setting, light, framing. Video:
 * subject and action, then the camera move stated plainly, then light and mood, one simple movement per clip.
 * `{{name}}` is a field the person fills in.
 */

export type TemplateKind = "image" | "video";
export type TemplateCategory = "product" | "ads" | "social" | "people" | "places" | "food" | "saved";

export interface PromptTemplate {
  id: string;
  title: string;
  tagline: string;
  category: TemplateCategory;
  kind: TemplateKind;
  /** The ratio it is composed for; used only when the model offers it. Soul v2, the default, has no 4:5. */
  ratio: string;
  prompt: string;
  /** Example text for a field, keyed by field name. */
  examples?: Record<string, string>;
  /** Saved templates only. */
  model?: string | null;
  resolution?: string | null;
  assetId?: string | null;
  createdAt?: string | null;
}

export const TEMPLATE_CATEGORIES: ReadonlyArray<{ id: TemplateCategory; label: string }> = [
  { id: "product", label: "Product" },
  { id: "ads", label: "Ads" },
  { id: "social", label: "Social" },
  { id: "people", label: "People" },
  { id: "places", label: "Places" },
  { id: "food", label: "Food" },
];

const NO_TEXT = "No text, lettering, logos or watermarks anywhere, including on products, packaging and signs.";
const PRODUCT = { product: "a matte black insulated coffee flask" };
const PERSON = { person: "a woman in her thirties in a navy blazer" };

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  // Product
  {
    id: "packshot", category: "product", kind: "image", ratio: "1:1", title: "Clean packshot", tagline: "White background, ready for a shop",
    prompt: `Commercial product photo of {{product}}, centred on a seamless pure white background. Soft even studio lighting, a faint natural shadow under the product, true-to-life colours, every edge sharp, shot on a 100mm lens. ${NO_TEXT}`,
    examples: PRODUCT,
  },
  {
    id: "lifestyle-scene", category: "product", kind: "image", ratio: "3:4", title: "Lifestyle scene", tagline: "Your product in real life",
    prompt: `{{product}} in use in {{setting}}. Natural window light from the left, a lived-in but tidy scene, shallow depth of field with the product in sharp focus, warm true-to-life colours, editorial lifestyle photography. ${NO_TEXT}`,
    examples: { ...PRODUCT, setting: "a sunlit kitchen on a weekday morning" },
  },
  {
    id: "dark-hero", category: "product", kind: "image", ratio: "16:9", title: "Dark hero shot", tagline: "Dramatic light for a launch",
    prompt: `Premium hero shot of {{product}} on a dark reflective surface against a deep charcoal gradient. Sculpted rim lighting tracing the edges, a soft glow behind it, a mirror reflection below, plenty of empty space on one side, shot on a 85mm lens. ${NO_TEXT}`,
    examples: PRODUCT,
  },
  {
    id: "flat-lay", category: "product", kind: "image", ratio: "1:1", title: "Styled flat lay", tagline: "Overhead with props that tell a story",
    prompt: `Overhead flat lay of {{product}} on {{surface}}, surrounded by a few carefully spaced props: {{props}}. Soft diffused daylight, gentle shadows, balanced composition with room to breathe, editorial styling. ${NO_TEXT}`,
    examples: { ...PRODUCT, surface: "warm oak wood", props: "a notebook, a sprig of eucalyptus and reading glasses" },
  },
  {
    id: "in-hand", category: "product", kind: "image", ratio: "3:4", title: "Product in hand", tagline: "Shows size and feels personal",
    prompt: `Close-up of a hand holding {{product}} toward the camera, with {{setting}} softly blurred behind. Natural daylight, realistic skin texture and fingers, the product label side facing forward and in sharp focus, shot on a 50mm lens. ${NO_TEXT}`,
    examples: { ...PRODUCT, setting: "a busy city street" },
  },
  {
    id: "ingredients", category: "product", kind: "image", ratio: "1:1", title: "Ingredients around it", tagline: "Shows what is inside",
    prompt: `{{product}} in the centre with its key ingredients arranged around it: {{ingredients}}. Clean {{colour}} background, soft top light, crisp detail on each ingredient, symmetrical composition, high-end advertising photography. ${NO_TEXT}`,
    examples: { product: "a bottle of cold-pressed juice", ingredients: "sliced oranges, fresh ginger and turmeric root", colour: "soft peach" },
  },
  // Ads
  {
    id: "copy-space", category: "ads", kind: "image", ratio: "16:9", title: "Ad with room for copy", tagline: "Clear space for your headline",
    prompt: `Advertising image of {{subject}} placed on the right third of the frame, with the left two thirds left as clean, uncluttered {{colour}} background for a headline. Bright commercial lighting, crisp focus, modern and confident mood. ${NO_TEXT}`,
    examples: { subject: "a smiling plumber holding a toolbox", colour: "deep blue" },
  },
  {
    id: "problem-solution", category: "ads", kind: "image", ratio: "1:1", title: "Before and after", tagline: "One image, the whole pitch",
    prompt: `Split-screen comparison image divided down the middle. Left side: {{before}}, in muted cool tones. Right side: {{after}}, in bright warm tones. Same camera angle and framing on both sides, realistic photography, clear contrast between the two. ${NO_TEXT}`,
    examples: { before: "a cluttered, dull office desk", after: "the same desk, tidy and full of daylight" },
  },
  {
    id: "seasonal", category: "ads", kind: "image", ratio: "3:4", title: "Seasonal promotion", tagline: "Black Friday, festive, back to school",
    prompt: `Promotional image of {{product}} styled for {{season}}. Tasteful themed props and colours around the product, rich but controlled lighting, the product as the clear focal point, a clean area at the top for an offer. ${NO_TEXT}`,
    examples: { ...PRODUCT, season: "the South African summer holidays" },
  },
  {
    id: "lead-magnet", category: "ads", kind: "image", ratio: "1:1", title: "Service you can't photograph", tagline: "For legal, finance and consulting",
    prompt: `A simple visual metaphor for {{service}}: {{metaphor}}. One clear subject on a clean {{colour}} background, soft directional light, polished and trustworthy, modern editorial style. ${NO_TEXT}`,
    examples: { service: "protecting a family's assets", metaphor: "a small house sheltered under a large open umbrella", colour: "warm grey" },
  },
  // Social
  {
    id: "carousel-cover", category: "social", kind: "image", ratio: "3:4", title: "Carousel cover", tagline: "Stops the scroll",
    prompt: `Eye-catching social media cover image about {{topic}}. One bold central subject, strong contrast against a saturated {{colour}} background, generous empty space at the top for a title, clean modern art direction. ${NO_TEXT}`,
    examples: { topic: "saving money on small business tax", colour: "emerald green" },
  },
  {
    id: "behind-scenes", category: "social", kind: "image", ratio: "3:4", title: "Behind the scenes", tagline: "Candid, real, not staged",
    prompt: `Candid behind-the-scenes photo of {{activity}} at {{place}}. Looks like a good phone photo: natural mixed light, slight motion and imperfection, people unaware of the camera, authentic and warm. ${NO_TEXT}`,
    examples: { activity: "a small team packing orders", place: "a busy workshop" },
  },
  {
    id: "quote-background", category: "social", kind: "image", ratio: "1:1", title: "Quote background", tagline: "Calm texture to put words on",
    prompt: `Minimal abstract background of {{texture}} in {{colour}} tones, with visible surface detail. Soft even light, gentle gradient, very low detail in the centre so words placed there stay easy to read, calm and premium. ${NO_TEXT}`,
    examples: { texture: "softly folded hand-made paper", colour: "sand and terracotta" },
  },
  {
    id: "story-vertical", category: "social", kind: "image", ratio: "9:16", title: "Vertical story", tagline: "Full screen for Stories and Status",
    prompt: `Vertical full-screen photograph of {{subject}} in {{setting}}, with the subject in the middle of the frame and calm, uncluttered space at the top and bottom. Vivid natural colour, strong sense of place. A real photograph, not a screenshot. ${NO_TEXT}`,
    examples: { subject: "a barista handing over a coffee", setting: "a sunny corner cafe" },
  },
  // People
  {
    id: "founder-portrait", category: "people", kind: "image", ratio: "3:4", title: "Founder portrait", tagline: "For the About page and press",
    prompt: `Editorial portrait of {{person}} in {{setting}}, relaxed confident expression, looking just off camera. Soft window light, background softly blurred, natural skin texture, shot on an 85mm lens at f/2. ${NO_TEXT}`,
    examples: { ...PERSON, setting: "their modern office" },
  },
  {
    id: "team-at-work", category: "people", kind: "image", ratio: "16:9", title: "Team at work", tagline: "For websites and proposals",
    prompt: `A small diverse team of {{team}} working together around {{setting}}, engaged and mid-conversation, nobody looking at the camera. Bright natural light, realistic candid moment, wide framing, true-to-life colours. ${NO_TEXT}`,
    examples: { team: "three colleagues", setting: "a shared table with laptops" },
  },
  {
    id: "happy-customer", category: "people", kind: "image", ratio: "3:4", title: "Happy customer", tagline: "The moment the product pays off",
    prompt: `{{person}} enjoying {{moment}}, a genuine unposed smile. Natural light, warm and optimistic mood, shallow depth of field, documentary-style photography that feels true rather than staged. ${NO_TEXT}`,
    examples: { person: "a retired couple", moment: "the keys to their new holiday home" },
  },
  // Places
  {
    id: "property-exterior", category: "places", kind: "image", ratio: "16:9", title: "Property at dusk", tagline: "The listing's first photo",
    prompt: `Exterior architectural photo of {{property}} at blue hour. Warm lights glowing in the windows, a calm deep-blue sky, straight vertical lines, well-kept surroundings, wide-angle real estate photography. ${NO_TEXT}`,
    examples: { property: "a modern thatched guest lodge in the Midlands" },
  },
  {
    id: "bright-interior", category: "places", kind: "image", ratio: "4:3", title: "Bright interior", tagline: "Airy and inviting rooms",
    prompt: `Interior photo of {{room}}, wide-angle from the corner of the room at chest height. Bright natural daylight, soft shadows, straight verticals, tidy and styled with a few simple details, inviting and true to life. ${NO_TEXT}`,
    examples: { room: "a coastal bedroom with white linen and a sea view" },
  },
  {
    id: "storefront", category: "places", kind: "image", ratio: "4:3", title: "Shop front", tagline: "Makes a local business look its best",
    prompt: `Street-level photo of {{business}} on a clear morning, a plain unbranded shopfront, the entrance inviting and well lit, a few people passing naturally, gentle sun on the facade, realistic urban detail. ${NO_TEXT}`,
    examples: { business: "a small independent bicycle shop" },
  },
  // Food
  {
    id: "food-overhead", category: "food", kind: "image", ratio: "1:1", title: "Table from above", tagline: "A full spread that looks generous",
    prompt: `Overhead photo of {{dishes}} arranged on {{surface}}, with hands reaching in to share. Soft window light, rich natural food colours, fresh garnish, inviting and abundant, editorial food photography. ${NO_TEXT}`,
    examples: { dishes: "a shared braai platter with salads", surface: "a rustic wooden table" },
  },
  {
    id: "food-closeup", category: "food", kind: "image", ratio: "3:4", title: "Hero dish", tagline: "Close enough to taste",
    prompt: `Close-up of {{dish}} from a 45-degree angle, with fresh texture and glistening detail in sharp focus and the background softly blurred. Warm side light, dark moody surface, shot on a 100mm macro lens. ${NO_TEXT}`,
    examples: { dish: "a stacked burger with melted cheddar" },
  },
  // Video
  {
    id: "video-orbit", category: "product", kind: "video", ratio: "1:1", title: "Slow product orbit", tagline: "A simple turn for any product",
    prompt: "Slow, smooth camera orbit around {{product}} standing on {{surface}}. The product stays still and centred. Soft studio lighting with a gentle moving highlight along its edges, premium calm mood, shallow depth of field.",
    examples: { ...PRODUCT, surface: "a dark stone plinth" },
  },
  {
    id: "video-push-in", category: "ads", kind: "video", ratio: "16:9", title: "Slow reveal", tagline: "Builds up to the product",
    prompt: "Slow camera push-in from a wide shot of {{setting}} toward {{product}}, which comes into sharp focus at the end of the shot. Morning light, soft haze in the air, cinematic and confident mood.",
    examples: { ...PRODUCT, setting: "a tidy workshop bench" },
  },
  {
    id: "video-ugc", category: "social", kind: "video", ratio: "9:16", title: "Customer selfie clip", tagline: "Feels like a real recommendation",
    prompt: "Handheld selfie-style vertical video of {{person}} holding up {{product}} and smiling at the camera in {{setting}}. Slight natural camera shake, real daylight, casual and authentic, looks filmed on a phone.",
    examples: { person: "a young woman", ...PRODUCT, setting: "her car" },
  },
  {
    id: "video-hands", category: "product", kind: "video", ratio: "9:16", title: "Hands at work", tagline: "Shows the craft or how it's used",
    prompt: "Close-up of hands {{action}}, the movement slow and deliberate. The camera stays locked off and steady. Soft side light, shallow depth of field, satisfying and precise.",
    examples: { action: "wrapping a handmade candle in brown paper" },
  },
  {
    id: "video-walkthrough", category: "places", kind: "video", ratio: "16:9", title: "Property glide", tagline: "A walk through the space",
    prompt: "Smooth gimbal shot gliding forward through {{room}} toward {{feature}}. Steady pace, bright natural daylight, straight lines, nobody in the frame, inviting and calm.",
    examples: { room: "an open-plan living room", feature: "glass doors that open onto a deck" },
  },
  {
    id: "video-food", category: "food", kind: "video", ratio: "9:16", title: "Pour or sizzle", tagline: "Makes people hungry",
    prompt: "Slow-motion close-up of {{action}}. The camera stays still while steam and droplets catch warm side light against a dark background, rich colour, mouth-watering detail.",
    examples: { action: "hot gravy being poured over a roast" },
  },
  {
    id: "video-founder", category: "people", kind: "video", ratio: "9:16", title: "Team member moment", tagline: "Puts a face to the business",
    prompt: "Slow camera push-in on {{person}} at work in {{setting}}, who looks up and smiles at the camera. Natural light, background softly blurred, warm and trustworthy mood.",
    examples: { ...PERSON, setting: "a sunny open-plan office" },
  },
];

const FIELD = /\{\{\s*([a-z][a-z0-9 _-]*?)\s*\}\}/gi;

/** The fields in a prompt, once each, in the order they first appear. */
export function placeholdersOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(FIELD)].map((m) => m[1]!.toLowerCase()))];
}

/** The prompt with every filled-in field replaced; a field left blank stays as `{{name}}`. */
export function fillPrompt(prompt: string, values: Record<string, string>): string {
  return prompt.replace(FIELD, (whole, name: string) => values[name.toLowerCase()]?.trim() || whole);
}

/** The fields a person still has to fill in. */
export function missingFields(prompt: string, values: Record<string, string>): string[] {
  return placeholdersOf(prompt).filter((name) => !values[name]?.trim());
}

/** "brand colour" -> "Brand colour". */
export function fieldLabel(name: string): string {
  const text = name.replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Templates for the gallery's search box and filters. An empty filter matches everything. */
export function filterTemplates(list: readonly PromptTemplate[], filter: { q?: string; category?: string; kind?: string }): PromptTemplate[] {
  const q = (filter.q ?? "").trim().toLowerCase();
  return list.filter((t) => {
    if (filter.category && t.category !== filter.category) return false;
    if (filter.kind && t.kind !== filter.kind) return false;
    return !q || `${t.title} ${t.tagline} ${t.prompt}`.toLowerCase().includes(q);
  });
}
