/**
 * Starter boards for the canvas: a client deliverable already wired together, so a person fills in a few fields and
 * presses Generate on each card. Pure and client-safe: the page and the worker both import it.
 *
 * The prompts are ours. They follow what the 2026 guides agree on: app store screenshots tell a story from the clearest
 * outcome onward, books design the character first and feed that sheet into every page, and images leave words to a
 * layout step, because image models garble lettering. Nothing here generates or costs anything by itself.
 */
import { MAX_LABEL, MAX_TEXT, type CanvasDoc, type CanvasEdge, type CanvasNode, type NodeType } from "./canvas-rules.js";

export type CanvasTemplateCategory = "apps" | "books" | "social" | "ads" | "products" | "places" | "food" | "brand" | "video" | "saved";

export interface CanvasTemplate {
  id: string;
  title: string;
  tagline: string;
  category: CanvasTemplateCategory;
  doc: CanvasDoc;
  /** Example text for a field, keyed by field name. */
  examples: Record<string, string>;
  createdAt?: string | null;
}

export const CANVAS_TEMPLATE_CATEGORIES: ReadonlyArray<{ id: CanvasTemplateCategory; label: string }> = [
  { id: "apps", label: "Apps" },
  { id: "books", label: "Books" },
  { id: "social", label: "Social" },
  { id: "ads", label: "Ads" },
  { id: "products", label: "Products" },
  { id: "places", label: "Places" },
  { id: "food", label: "Food" },
  { id: "brand", label: "Brand" },
  { id: "video", label: "Video" },
];

const COL = 400;
const ROW = 230;
const NO_TEXT = "No text, lettering, logos or watermarks anywhere.";

interface Step {
  id: string;
  type: NodeType;
  label: string;
  /** A prompt card's words. */
  text?: string;
  /** A generating card's own direction. */
  prompt?: string;
  ratio?: string;
  from?: string[];
}

/** Lays steps out left to right: each card one column right of what feeds it, top to bottom in the order given. */
export function layoutBoard(steps: readonly Step[]): CanvasDoc {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = (s: Step): number => (s.from?.length ? 1 + Math.max(...s.from.map((id) => depth(byId.get(id)!))) : 0);
  const rows = new Map<number, number>();
  const nodes: CanvasNode[] = steps.map((s) => {
    const col = depth(s);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    const data: Record<string, string> = { label: s.label };
    if (s.text) data.text = s.text;
    if (s.prompt) data.prompt = s.prompt;
    if (s.ratio) data.ratio = s.ratio;
    return { id: s.id, type: s.type, position: { x: col * COL, y: row * ROW }, data };
  });
  const edges: CanvasEdge[] = steps.flatMap((s) => (s.from ?? []).map((from) => ({ id: `e-${from}-${s.id}`, source: from, target: s.id })));
  return { nodes, edges, viewport: { x: 40, y: 40, zoom: 0.7 } };
}

const FIELD = /\{\{\s*([a-z][a-z0-9 _-]*?)\s*\}\}/gi;

/** Every field on a board, once each, in the order the cards use them. */
export function boardFields(doc: CanvasDoc): string[] {
  const text = doc.nodes.flatMap((n) => [n.data.label ?? "", n.data.text ?? "", n.data.prompt ?? ""]).join("\n");
  return [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!.toLowerCase()))];
}

/** The board with its fields filled in. A field left blank stays visible on the card, to fill in there. */
export function fillBoard(doc: CanvasDoc, values: Record<string, string>): CanvasDoc {
  const fill = (value: string, max: number) => value.replace(FIELD, (whole, name: string) => values[name.toLowerCase()]?.trim() || whole).slice(0, max);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      const data = { ...n.data };
      if (data.label) data.label = fill(data.label, MAX_LABEL);
      if (data.text) data.text = fill(data.text, MAX_TEXT);
      if (data.prompt) data.prompt = fill(data.prompt, MAX_TEXT);
      return { ...n, data };
    }),
  };
}

/** A saved board with its files and results taken out: a template is the wiring and the words, never a client's files. */
export function boardToTemplateDoc(doc: CanvasDoc): CanvasDoc {
  const nodes = doc.nodes.filter((n) => !(n.type === "output" && n.data.generated));
  const ids = new Set(nodes.map((n) => n.id));
  return {
    viewport: doc.viewport,
    edges: doc.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    nodes: nodes.map((n) => {
      const { assetId: _asset, groupId: _group, generated: _generated, ...data } = n.data;
      return { ...n, data };
    }),
  };
}

/** "5 pictures, 1 video" for a card. */
export function boardSummary(doc: CanvasDoc): string {
  const count = (type: NodeType) => doc.nodes.filter((n) => n.type === type).length;
  const pictures = count("image");
  const videos = count("video");
  const parts = [pictures ? `${pictures} ${pictures === 1 ? "picture" : "pictures"}` : "", videos ? `${videos} ${videos === 1 ? "video" : "videos"}` : ""].filter(Boolean);
  return parts.join(", ") || `${doc.nodes.length} cards`;
}

const template = (id: string, category: CanvasTemplateCategory, title: string, tagline: string, examples: Record<string, string>, steps: Step[]): CanvasTemplate => ({
  id,
  category,
  title,
  tagline,
  examples,
  doc: layoutBoard(steps),
});

const pages = (scenes: Array<[string, string]>, ratio: string, from: string[]): Step[] =>
  scenes.map(([label, prompt], i) => ({ id: `page${i + 1}`, type: "image" as const, label, prompt, ratio, from }));

export const CANVAS_TEMPLATES: readonly CanvasTemplate[] = [
  template("app-store-set", "apps", "App store screenshots", "Five frames that tell the story, from your real screen", { app: "a budgeting app", audience: "young families", outcome: "knowing exactly where the month's money went" }, [
    { id: "look", type: "prompt", label: "Look of the set", text: `App store screenshot artwork for {{app}}, for {{audience}}. A modern phone shown at a slight angle with the attached screen displayed on it, exactly as it is. Bold single-colour background, soft studio light, the top third left completely empty for a caption added later. ${NO_TEXT}` },
    { id: "screen", type: "source", label: "Your app screen (pick a file)" },
    { id: "captions", type: "prompt", label: "Captions to add later (not sent to the model)", text: "1. {{outcome}}\n2. The problem it solves\n3. The feature people love\n4. The next feature\n5. Why people trust it\n\nKeep each to a few words: it has to read at preview size." },
    ...[["1. The outcome", "This frame shows the result: {{outcome}}. Confident and clear, the strongest colour of the set."], ["2. The problem", "A calmer, cooler frame that hints at the everyday problem this solves for {{audience}}."], ["3. Main feature", "The phone large and close, the screen filling most of the frame."], ["4. Second feature", "The phone tilted the other way, with soft floating shapes behind it."], ["5. Trust", "A warm, friendly frame with a hand holding the phone."]].map(([label, prompt], i): Step => ({ id: `shot${i + 1}`, type: "image", label: label!, prompt: prompt!, ratio: "9:16", from: ["look", "screen"] })),
  ]),
  template("app-launch-promo", "apps", "App launch video", "One screen becomes a store preview and a social clip", { app: "a budgeting app", moment: "someone relaxing after sorting their month" }, [
    { id: "screen", type: "source", label: "Your app screen (pick a file)" },
    { id: "hero", type: "image", label: "Hero frame", prompt: `A person's hand holding a phone showing the attached screen from {{app}}, in a bright modern home, {{moment}}. Natural light, shallow depth of field. ${NO_TEXT}`, ratio: "9:16", from: ["screen"] },
    { id: "clip", type: "video", label: "Short clip", prompt: "Slow camera push-in toward the phone. The hand stays steady, soft daylight moves gently across the room. Calm and confident.", ratio: "9:16", from: ["hero"] },
  ]),
  template("picture-book", "books", "Illustrated book", "Design the character once, keep them the same on every page", { character: "Thandi, a curious eight-year-old with two puffs and a yellow raincoat", world: "a coastal town in KwaZulu-Natal", lesson: "being brave enough to ask for help", style: "warm watercolour with soft ink lines" }, [
    { id: "style", type: "prompt", label: "Art style (used on every page)", text: `A children's book illustration in {{style}}, set in {{world}}. Gentle colour, clear shapes, room at the bottom of the page for words added later. ${NO_TEXT}` },
    { id: "story", type: "prompt", label: "Story notes (not sent to the model)", text: "Main character: {{character}}\nLesson: {{lesson}}\n\nWrite the words for each page here, or give this board to an agent. Add them to the pages after the pictures are done: image models garble lettering." },
    { id: "sheet", type: "image", label: "Character sheet: approve this first", prompt: `A character reference sheet of {{character}}: front, three-quarter and side views on a plain background, same outfit in every view, with colour swatches. ${NO_TEXT}`, ratio: "1:1", from: ["style"] },
    ...pages([
      ["Page 1: opening", "The same character at home in {{world}} on an ordinary, happy morning."],
      ["Page 2: the problem", "The same character facing a problem that needs {{lesson}}, looking worried."],
      ["Page 3: the try", "The same character trying alone and it not working out, with a gentle humour."],
      ["Page 4: the turn", "The same character finally {{lesson}}, and a kind friend helping."],
      ["Page 5: the ending", "The same character and the friend celebrating at sunset, the problem solved."],
    ], "4:3", ["style", "sheet"]),
  ]),
  template("ebook", "books", "Ebook or lead magnet", "A cover and matching chapter openers for a guide", { topic: "a first-time buyer's guide to property", audience: "young South African professionals", colour: "deep teal and warm sand" }, [
    { id: "words", type: "prompt", label: "Outline (not sent to the model)", text: "Topic: {{topic}}\nFor: {{audience}}\n\nChapter 1:\nChapter 2:\nChapter 3:\n\nWrite the chapters here or give the board to an agent. Add the title to the cover afterwards." },
    { id: "cover", type: "image", label: "Cover art: approve this first", prompt: `Premium editorial cover artwork about {{topic}} for {{audience}}. One strong central visual metaphor, palette of {{colour}}, the top half calm and empty for a title added later. ${NO_TEXT}`, ratio: "3:4" },
    ...pages([
      ["Chapter 1 opener", "In exactly the same style and palette as the attached cover: a simple visual for getting started with {{topic}}."],
      ["Chapter 2 opener", "In exactly the same style and palette as the attached cover: a simple visual for the biggest mistake people make with {{topic}}."],
      ["Chapter 3 opener", "In exactly the same style and palette as the attached cover: a simple visual for succeeding at {{topic}}."],
    ], "4:3", ["cover"]),
  ]),
  template("social-week", "social", "A week of social posts", "Five posts that look like one brand", { brand: "a neighbourhood coffee roaster", look: "warm morning light, earthy tones and a lot of texture" }, [
    { id: "anchor", type: "image", label: "Style anchor: approve this first", prompt: `A brand image for {{brand}}: {{look}}. Editorial, confident and uncluttered. ${NO_TEXT}`, ratio: "3:4" },
    ...pages([
      ["Monday: a useful tip", "Same look as the attached image: a close-up that illustrates a practical tip from {{brand}}."],
      ["Tuesday: behind the scenes", "Same look as the attached image: candid behind-the-scenes moment at {{brand}}, people unaware of the camera."],
      ["Wednesday: a customer", "Same look as the attached image: a real customer enjoying what {{brand}} offers, a natural smile."],
      ["Thursday: the product", "Same look as the attached image: the star product of {{brand}}, styled simply."],
      ["Friday: an offer", "Same look as the attached image: an inviting scene with a clean area at the top for an offer added later."],
    ], "3:4", ["anchor"]),
  ]),
  template("ad-test", "ads", "Ad test: four hooks", "One product, four angles, see which one wins", { audience: "busy commuters" }, [
    { id: "product", type: "source", label: "Your product photo (pick a file)" },
    ...pages([
      ["Hook 1: the problem", "The attached product shown beside the everyday frustration it fixes for {{audience}}. Clear space on one side for a headline added later."],
      ["Hook 2: the outcome", "The attached product in the happy moment after the problem is gone, for {{audience}}. Bright and optimistic."],
      ["Hook 3: social proof", "A real-looking person from {{audience}} using the attached product, shot like a good phone photo."],
      ["Hook 4: the offer", "The attached product as a bold hero on a saturated background with a clear area for an offer added later."],
    ].map(([l, p]) => [l!, `${p} ${NO_TEXT}`] as [string, string]), "1:1", ["product"]),
  ]),
  template("product-launch", "products", "Product launch kit", "Hero shot, lifestyle, ad and a video, all from one photo", { setting: "a sunlit kitchen on a weekday morning" }, [
    { id: "product", type: "source", label: "Your product photo (pick a file)" },
    { id: "hero", type: "image", label: "Hero shot: approve this first", prompt: `The attached product on a dark reflective surface with sculpted rim light and a soft glow behind it. Premium launch feel. ${NO_TEXT}`, ratio: "16:9", from: ["product"] },
    { id: "life", type: "image", label: "Lifestyle", prompt: `The same product in use in {{setting}}, natural light, editorial lifestyle photography. ${NO_TEXT}`, ratio: "3:4", from: ["hero"] },
    { id: "ad", type: "image", label: "Ad with room for copy", prompt: `The same product on the right third of the frame, the left two thirds a clean, calm background for a headline added later. ${NO_TEXT}`, ratio: "16:9", from: ["hero"] },
    { id: "clip", type: "video", label: "Launch clip", prompt: "Slow, smooth camera orbit around the product. The product stays still and centred, a highlight glides along its edges.", ratio: "16:9", from: ["hero"] },
  ]),
  template("property-listing", "places", "Property listing", "The photos and walkthrough a listing needs", { property: "a modern thatched guest lodge", location: "the KwaZulu-Natal Midlands" }, [
    { id: "style", type: "prompt", label: "Photography style", text: `Real estate photography of {{property}} in {{location}}: straight vertical lines, true-to-life colour, inviting and uncluttered, nobody in the frame. ${NO_TEXT}` },
    { id: "front", type: "image", label: "Front at dusk", prompt: "The exterior at blue hour, warm lights glowing in the windows, calm deep-blue sky.", ratio: "16:9", from: ["style"] },
    { id: "living", type: "image", label: "Living space", prompt: "The main living space in bright daylight, wide-angle from the corner of the room.", ratio: "4:3", from: ["style"] },
    { id: "bedroom", type: "image", label: "Main bedroom", prompt: "The main bedroom with crisp linen, soft morning light, a view out of the window.", ratio: "4:3", from: ["style"] },
    { id: "view", type: "image", label: "The view", prompt: "The view from the property at golden hour, showing what makes the location special.", ratio: "16:9", from: ["style"] },
    { id: "glide", type: "video", label: "Walkthrough", prompt: "Smooth gimbal shot gliding slowly toward the front door at dusk, steady pace, warm windows glowing.", ratio: "16:9", from: ["front"] },
  ]),
  template("restaurant", "food", "Restaurant launch", "Hero dish, table, venue and a clip that makes people hungry", { restaurant: "a family Italian kitchen", dish: "a wood-fired margherita pizza", spread: "shared plates of pasta, salad and bread" }, [
    { id: "style", type: "prompt", label: "Food style", text: `Editorial food and hospitality photography for {{restaurant}}: warm side light, rich natural colour, inviting and generous. ${NO_TEXT}` },
    { id: "hero", type: "image", label: "Hero dish", prompt: "{{dish}} close up from a 45-degree angle, glistening detail in sharp focus, the background softly blurred.", ratio: "3:4", from: ["style"] },
    { id: "table", type: "image", label: "Table from above", prompt: "Overhead view of {{spread}} on a rustic table, with hands reaching in to share.", ratio: "1:1", from: ["style"] },
    { id: "room", type: "image", label: "The room", prompt: "The dining room in the early evening, warm lamps, a few guests talking, nobody looking at the camera.", ratio: "16:9", from: ["style"] },
    { id: "clip", type: "video", label: "Sizzle clip", prompt: "Slow-motion close-up. The camera stays still while steam rises and catches the warm light.", ratio: "9:16", from: ["hero"] },
  ]),
  template("youtube-thumbnails", "video", "YouTube thumbnails", "Three versions to test, with room for the title", { topic: "how I paid off my bond in five years", person: "a man in his forties in a navy shirt", emotion: "genuine surprise" }, [
    { id: "base", type: "prompt", label: "Thumbnail style", text: `YouTube thumbnail about {{topic}}. High contrast, saturated colour, one clear subject that still reads at a very small size, the left half clean for a title added later. ${NO_TEXT}` },
    { id: "face", type: "image", label: "Version A: face", prompt: "{{person}} on the right, showing {{emotion}}, looking straight at the camera, sharp and well lit.", ratio: "16:9", from: ["base"] },
    { id: "object", type: "image", label: "Version B: object", prompt: "One bold object that sums up the topic, huge in the frame on the right, with a dramatic glow.", ratio: "16:9", from: ["base"] },
    { id: "contrast", type: "image", label: "Version C: before and after", prompt: "A split frame on the right half: dull and cool on one side, bright and warm on the other, showing the change.", ratio: "16:9", from: ["base"] },
  ]),
  template("ugc-ad", "video", "Customer-style video ad", "Hook, demo and payoff, filmed like a real phone clip", { person: "a young woman", product: "a matte black insulated coffee flask", place: "her car" }, [
    { id: "style", type: "prompt", label: "Filmed on a phone", text: "Handheld vertical video filmed on a phone, real daylight, slight natural camera shake, casual and authentic." },
    { id: "hook", type: "video", label: "1. The hook", prompt: "{{person}} in {{place}} looks into the camera, surprised, and holds up {{product}}.", ratio: "9:16", from: ["style"] },
    { id: "demo", type: "video", label: "2. The demo", prompt: "Close-up of hands using {{product}}, showing the one thing it does better.", ratio: "9:16", from: ["style"] },
    { id: "payoff", type: "video", label: "3. The payoff", prompt: "{{person}} smiles and nods at the camera, happy with {{product}}.", ratio: "9:16", from: ["style"] },
  ]),
  template("explainer", "video", "Explainer storyboard", "Four scenes approved as pictures, then brought to life", { subject: "how a small business gets its first online customer", look: "friendly flat illustration in teal and coral" }, [
    { id: "style", type: "prompt", label: "Look of the film", text: `An explainer film about {{subject}} in the style of {{look}}. Simple shapes and one clear idea per scene. ${NO_TEXT}` },
    ...pages([["Scene 1: the problem", "The situation before: something is not working."], ["Scene 2: the idea", "The moment the idea appears."], ["Scene 3: how it works", "The idea in action, step by step."], ["Scene 4: the result", "The happy result."]], "16:9", ["style"]),
    ...[1, 2, 3, 4].map((n): Step => ({ id: `clip${n}`, type: "video", label: `Scene ${n}: moving`, prompt: "Gentle animation of this scene: slow camera drift and one small movement.", ratio: "16:9", from: [`page${n}`] })),
  ]),
  template("blog-heroes", "brand", "Blog hero images", "A matching picture for four SEO articles", { business: "a family law practice", look: "calm editorial photography with soft natural light", article1: "what to do first after a separation", article2: "how child maintenance is worked out", article3: "mediation or court", article4: "writing a will that holds up" }, [
    { id: "anchor", type: "image", label: "Style anchor: approve this first", prompt: `An image for {{business}}: {{look}}. Thoughtful, human and reassuring. ${NO_TEXT}`, ratio: "16:9" },
    ...[1, 2, 3, 4].map((n): Step => ({ id: `post${n}`, type: "image", label: `Article ${n}`, prompt: `Same look as the attached image: a simple scene or visual metaphor for "{{article${n}}}". ${NO_TEXT}`, ratio: "16:9", from: ["anchor"] })),
  ]),
  template("trust-visuals", "brand", "Service you can't photograph", "Visual metaphors for legal, finance and consulting", { service: "estate planning", benefit: "protecting a family's future", colour: "warm grey and deep navy" }, [
    { id: "style", type: "prompt", label: "Shared look", text: `A simple visual metaphor about {{service}} on a clean {{colour}} background. One clear subject, soft directional light, polished and trustworthy, modern editorial style. ${NO_TEXT}` },
    { id: "a", type: "image", label: "Protection", prompt: "Something small and precious sheltered by something strong, showing {{benefit}}.", ratio: "1:1", from: ["style"] },
    { id: "b", type: "image", label: "Clarity", prompt: "A tangled line becoming one clear straight path.", ratio: "1:1", from: ["style"] },
    { id: "c", type: "image", label: "Growth", prompt: "Something small growing steadily over time, carefully looked after.", ratio: "1:1", from: ["style"] },
    { id: "d", type: "image", label: "Partnership", prompt: "Two hands completing something together, seen close up.", ratio: "1:1", from: ["style"] },
  ]),
];

/** Templates for the gallery's filters. An empty filter matches everything. */
export function filterCanvasTemplates(list: readonly CanvasTemplate[], filter: { q?: string; category?: string }): CanvasTemplate[] {
  const q = (filter.q ?? "").trim().toLowerCase();
  return list.filter((t) => (!filter.category || t.category === filter.category) && (!q || `${t.title} ${t.tagline}`.toLowerCase().includes(q)));
}

/** "article1" -> "Article 1", "brand_colour" -> "Brand colour". */
export function boardFieldLabel(name: string): string {
  const text = name.replace(/[_-]+/g, " ").replace(/([a-z])(\d)/g, "$1 $2");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
