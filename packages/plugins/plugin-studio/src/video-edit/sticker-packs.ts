/**
 * The closed sticker manifest (schema v5): every sticker id an edit may name, per bundled pack. Pure (no fs), so the
 * page, `normalizeEdit` and the render share it. The PNGs and the path lookup live in `stickers.ts` (PAR-8279 D4b),
 * which resolves `<pack>/<id>.png` from these keys only; a doc string never becomes a path.
 * - `noto-emoji`: a Noto Emoji subset (Apache-2.0), id -> Unicode codepoint (hex) of the source `emoji_u<cp>.png`.
 * - `pib-shapes`: shapes drawn by `scripts/gen-pib-shapes.mjs` (ours), id -> label.
 * Ids may be added in a later release; never remove or rename one (a stored edit naming it would stop loading).
 */
export const STICKER_PACKS = ["noto-emoji", "pib-shapes"] as const;
export type StickerPack = (typeof STICKER_PACKS)[number];
export interface StickerRef { pack: StickerPack; id: string }

export const NOTO_EMOJI: Readonly<Record<string, string>> = Object.freeze({
  "grinning-face": "1f600", "beaming-face": "1f601", joy: "1f602", rofl: "1f923", smile: "1f604", wink: "1f609",
  blush: "1f60a", "heart-eyes": "1f60d", "star-struck": "1f929", kiss: "1f618", yum: "1f60b", tongue: "1f61c",
  zany: "1f92a", "money-mouth": "1f911", hugging: "1f917", thinking: "1f914", shush: "1f92b",
  "raised-eyebrow": "1f928", neutral: "1f610", "eye-roll": "1f644", smirk: "1f60f", relieved: "1f60c",
  sleeping: "1f634", nerd: "1f913", sunglasses: "1f60e", "party-face": "1f973", cowboy: "1f920",
  "mind-blown": "1f92f", "hot-face": "1f975", pleading: "1f97a", cry: "1f622", sob: "1f62d", scream: "1f631",
  astonished: "1f632", flushed: "1f633", angry: "1f621", rage: "1f92c", skull: "1f480", ghost: "1f47b",
  alien: "1f47d", robot: "1f916", poop: "1f4a9", clown: "1f921", "see-no-evil": "1f648", "thumbs-up": "1f44d",
  "thumbs-down": "1f44e", clap: "1f44f", "raised-hands": "1f64c", pray: "1f64f", wave: "1f44b", "ok-hand": "1f44c",
  victory: "270c", "crossed-fingers": "1f91e", "love-you": "1f91f", "point-up": "1f446", "point-down": "1f447",
  "point-left": "1f448", "point-right": "1f449", muscle: "1f4aa", handshake: "1f91d", eyes: "1f440", brain: "1f9e0",
  "red-heart": "2764", "orange-heart": "1f9e1", "yellow-heart": "1f49b", "green-heart": "1f49a",
  "blue-heart": "1f499", "purple-heart": "1f49c", "broken-heart": "1f494", "sparkling-heart": "1f496",
  "two-hearts": "1f495", "kiss-mark": "1f48b", hundred: "1f4af", collision: "1f4a5", dizzy: "1f4ab",
  "sweat-drops": "1f4a6", dash: "1f4a8", speech: "1f4ac", thought: "1f4ad", fire: "1f525", sparkles: "2728",
  star: "2b50", "glowing-star": "1f31f", lightning: "26a1", rainbow: "1f308", sun: "2600", cloud: "2601",
  snowflake: "2744", droplet: "1f4a7", ocean: "1f30a", rocket: "1f680", "party-popper": "1f389", confetti: "1f38a",
  balloon: "1f388", gift: "1f381", trophy: "1f3c6", "gold-medal": "1f947", crown: "1f451", gem: "1f48e",
  "money-bag": "1f4b0", "money-wings": "1f4b8", "shopping-bags": "1f6cd", "shopping-cart": "1f6d2",
  "chart-up": "1f4c8", "chart-down": "1f4c9", "bar-chart": "1f4ca", alarm: "23f0", phone: "1f4f1", camera: "1f4f7",
  "video-camera": "1f3a5", clapper: "1f3ac", microphone: "1f3a4", headphones: "1f3a7", music: "1f3b6",
  megaphone: "1f4e3", loudspeaker: "1f4e2", bell: "1f514", "light-bulb": "1f4a1", magnifier: "1f50d", lock: "1f512",
  key: "1f511", pin: "1f4cc", memo: "1f4dd", target: "1f3af", coffee: "2615", pizza: "1f355", burger: "1f354",
  cake: "1f382", champagne: "1f37e", "clinking-glasses": "1f942", rose: "1f339", sunflower: "1f33b", dog: "1f436",
  cat: "1f431", butterfly: "1f98b", check: "2705", cross: "274c", warning: "26a0", "no-entry": "26d4",
  question: "2753", exclamation: "2757", new: "1f195", sos: "1f198", free: "1f193", cool: "1f192",
  "up-arrow": "2b06", "down-arrow": "2b07", "right-arrow": "27a1", "left-arrow": "2b05", "red-circle": "1f534",
});

export const PIB_SHAPES: Readonly<Record<string, string>> = Object.freeze({
  circle: "Circle", ring: "Ring", square: "Square", "rounded-square": "Rounded square", triangle: "Triangle", diamond: "Diamond",
  star: "Star", heart: "Heart", burst: "Burst", "speech-bubble": "Speech bubble", "thought-bubble": "Thought bubble",
  "arrow-right": "Arrow right", "arrow-left": "Arrow left", "arrow-up": "Arrow up", "arrow-down": "Arrow down",
  "curved-arrow": "Curved arrow", check: "Check", cross: "Cross", plus: "Plus", underline: "Underline", "scribble-circle": "Scribble circle",
  "highlight-bar": "Highlight bar", "price-tag": "Price tag", badge: "Badge",
});

const MANIFEST: Readonly<Record<StickerPack, Readonly<Record<string, string>>>> = { "noto-emoji": NOTO_EMOJI, "pib-shapes": PIB_SHAPES };

/** The ids of a pack, in manifest order. */
export function stickerIds(pack: StickerPack): string[] {
  return Object.keys(MANIFEST[pack]);
}
/** True when `pack` is a bundled pack and `id` one of its stickers (own keys only: `__proto__` and the like are not ids). */
export function isSticker(pack: unknown, id: unknown): pack is StickerPack {
  return typeof pack === "string" && (STICKER_PACKS as readonly string[]).includes(pack) && typeof id === "string" && Object.hasOwn(MANIFEST[pack as StickerPack], id);
}

/** pack -> id -> file name, built once from the manifest. The only source of a sticker's file name. */
const FILES: ReadonlyMap<StickerPack, ReadonlyMap<string, string>> = new Map(
  STICKER_PACKS.map((pack) => [pack, new Map(stickerIds(pack).map((id) => [id, `${id}.png`]))]),
);

/**
 * The `<pack>/<id>.png` path (relative, `/` separated) a sticker is served at, by map lookup in the manifest; throws
 * for anything not in it. Pure, so the render (`stickers.ts`) and the browser preview build the same path from it.
 */
export function stickerRelPath(ref: unknown): string {
  const r = ref as { pack?: unknown; id?: unknown } | null | undefined;
  if (!r || !isSticker(r.pack, r.id)) throw new Error("Unknown sticker.");
  return `${r.pack}/${FILES.get(r.pack as StickerPack)!.get(r.id as string)!}`;
}
