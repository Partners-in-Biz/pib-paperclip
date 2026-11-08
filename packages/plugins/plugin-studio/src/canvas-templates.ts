/**
 * Starter boards for the canvas: a client deliverable already wired together, so a person fills in a few fields and
 * presses Generate on each card. Pure and client-safe: the page and the worker both import it.
 *
 * The prompts are ours. They follow what the 2026 guides agree on: app store screenshots tell a story from the clearest
 * outcome onward, and books design the character first and feed that sheet into every page. Pictures never carry words:
 * image models garble lettering, so a Text card holds the words and a Layout card sets them as real text at the exact
 * size a store or printer asks for. Nothing here generates or costs anything by itself.
 */
import { PROMPT_TEMPLATES } from "./prompt-templates.js";
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
  /** The rest of a card's settings: a Text card's brief, a Layout card's size and style. */
  data?: Record<string, string>;
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
    Object.assign(data, s.data);
    return { id: s.id, type: s.type, position: { x: col * COL, y: row * ROW }, data };
  });
  const edges: CanvasEdge[] = steps.flatMap((s) => (s.from ?? []).map((from) => ({ id: `e-${from}-${s.id}`, source: from, target: s.id })));
  return { nodes, edges, viewport: { x: 40, y: 40, zoom: 0.7 } };
}

const FIELD = /\{\{\s*([a-z][a-z0-9 _-]*?)\s*\}\}/gi;

/** Every field on a board, once each, in the order the cards use them. */
export function boardFields(doc: CanvasDoc): string[] {
  const text = doc.nodes.flatMap((n) => [n.data.label ?? "", n.data.text ?? "", n.data.prompt ?? "", n.data.brief ?? ""]).join("\n");
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
      if (data.brief) data.brief = fill(data.brief, MAX_TEXT);
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
      const { assetId: _asset, groupId: _group, generated: _generated, requested: _requested, ...data } = n.data;
      return { ...n, data };
    }),
  };
}

/** "5 pictures, 1 video" for a card. */
export function boardSummary(doc: CanvasDoc): string {
  const count = (type: NodeType) => doc.nodes.filter((n) => n.type === type).length;
  const pictures = count("image");
  const videos = count("video");
  const pages = count("layout");
  const parts = [pictures ? `${pictures} ${pictures === 1 ? "picture" : "pictures"}` : "", videos ? `${videos} ${videos === 1 ? "video" : "videos"}` : "", pages ? `${pages} finished ${pages === 1 ? "page" : "pages"}` : ""].filter(Boolean);
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

/** One Layout card per picture, each taking its own part of the Text card. */
const finished = (pictures: string[], words: string, labels: string[], settings: Record<string, string>): Step[] =>
  pictures.map((picture, i) => ({ id: `done${i + 1}`, type: "layout" as const, label: labels[i] ?? `Page ${i + 1}`, from: [picture, words], data: { ...settings, part: String(i + 1) } }));

const CORE_BOARDS: readonly CanvasTemplate[] = [
  template("app-store-set", "apps", "App store screenshots", "Five finished screenshots at Apple's exact size, from your real screen", { app: "a budgeting app", audience: "young families", outcome: "Know where every rand went" }, [
    { id: "look", type: "prompt", label: "Look of the set", text: `App store screenshot artwork for {{app}}, for {{audience}}. A modern phone shown at a slight angle with the attached screen displayed on it, exactly as it is. Bold single-colour background, soft studio light, the top third left completely empty. ${NO_TEXT}` },
    { id: "screen", type: "source", label: "Your app screen (pick a file)" },
    { id: "captions", type: "text", label: "Captions", text: "{{outcome}}\n---\nThe problem it solves\n---\nThe feature people love\n---\nThe next feature\n---\nWhy people trust it", data: { brief: "Five short captions for app store screenshots of {{app}}, for {{audience}}. Lead with the clearest outcome, then tell a story. Each must read at preview size: a few words, specific, no broad claims like best app." } },
    ...[["1. The outcome", "This frame shows the result. Confident and clear, the strongest colour of the set."], ["2. The problem", "A calmer, cooler frame that hints at the everyday problem this solves for {{audience}}."], ["3. Main feature", "The phone large and close, the screen filling most of the frame."], ["4. Second feature", "The phone tilted the other way, with soft floating shapes behind it."], ["5. Trust", "A warm, friendly frame with a hand holding the phone."]].map(([label, prompt], i): Step => ({ id: `shot${i + 1}`, type: "image", label: label!, prompt: prompt!, ratio: "9:16", from: ["look", "screen"] })),
    ...finished(["shot1", "shot2", "shot3", "shot4", "shot5"], "captions", ["Screenshot 1", "Screenshot 2", "Screenshot 3", "Screenshot 4", "Screenshot 5"], { size: "app-store-iphone", position: "top", style: "headline", colour: "light" }),
  ]),
  template("app-launch-promo", "apps", "App launch video", "One screen becomes a store preview and a social clip", { app: "a budgeting app", moment: "someone relaxing after sorting their month" }, [
    { id: "screen", type: "source", label: "Your app screen (pick a file)" },
    { id: "hero", type: "image", label: "Hero frame", prompt: `A person's hand holding a phone showing the attached screen from {{app}}, in a bright modern home, {{moment}}. Natural light, shallow depth of field. ${NO_TEXT}`, ratio: "9:16", from: ["screen"] },
    { id: "clip", type: "video", label: "Short clip", prompt: "Slow camera push-in toward the phone. The hand stays steady, soft daylight moves gently across the room. Calm and confident.", ratio: "9:16", from: ["hero"] },
  ]),
  template("picture-book", "books", "Illustrated book", "Same character on every page, words set properly, exported as a PDF", { character: "Thandi, a curious eight-year-old with two puffs and a yellow raincoat", world: "a coastal town in KwaZulu-Natal", lesson: "being brave enough to ask for help", style: "warm watercolour with soft ink lines" }, [
    { id: "style", type: "prompt", label: "Art style (used on every page)", text: `A children's book illustration in {{style}}, set in {{world}}. Gentle colour and clear shapes. ${NO_TEXT}` },
    { id: "story", type: "text", label: "The story", text: "Words for page 1\n---\nWords for page 2\n---\nWords for page 3\n---\nWords for page 4\n---\nWords for page 5", data: { brief: "A five-page children's story about {{character}}, set in {{world}}, about {{lesson}}. Page 1: an ordinary, happy morning. Page 2: a problem appears. Page 3: trying alone and it not working. Page 4: finally asking, and a friend helping. Page 5: a warm ending. Two short sentences a page, for ages 5 to 8." } },
    { id: "sheet", type: "image", label: "Character sheet: approve this first", prompt: `A character reference sheet of {{character}}: front, three-quarter and side views on a plain background, same outfit in every view, with colour swatches. ${NO_TEXT}`, ratio: "1:1", from: ["style"] },
    ...pages([
      ["Page 1: opening", "The same character at home in {{world}} on an ordinary, happy morning."],
      ["Page 2: the problem", "The same character facing a problem that needs {{lesson}}, looking worried."],
      ["Page 3: the try", "The same character trying alone and it not working out, with a gentle humour."],
      ["Page 4: the turn", "The same character finally {{lesson}}, and a kind friend helping."],
      ["Page 5: the ending", "The same character and the friend celebrating at sunset, the problem solved."],
    ], "4:3", ["style", "sheet"]),
    ...finished(["page1", "page2", "page3", "page4", "page5"], "story", ["Finished page 1", "Finished page 2", "Finished page 3", "Finished page 4", "Finished page 5"], { size: "book-landscape", position: "below", style: "body", font: "serif", colour: "dark" }),
  ]),
  template("ebook", "books", "Ebook or lead magnet", "A titled cover and matching chapter openers, exported as a PDF", { title: "Your first home", topic: "a first-time buyer's guide to property", audience: "young South African professionals", colour: "deep teal and warm sand" }, [
    { id: "words", type: "text", label: "Titles", text: "{{title}}\n---\nChapter 1\n---\nChapter 2\n---\nChapter 3", data: { brief: "The cover title and three chapter titles for {{topic}}, for {{audience}}. Short and specific." } },
    { id: "cover", type: "image", label: "Cover art: approve this first", prompt: `Premium editorial cover artwork about {{topic}} for {{audience}}. One strong central visual metaphor, palette of {{colour}}, the top half calm and empty. ${NO_TEXT}`, ratio: "3:4" },
    ...pages([
      ["Chapter 1 opener", "In exactly the same style and palette as the attached cover: a simple visual for getting started with {{topic}}."],
      ["Chapter 2 opener", "In exactly the same style and palette as the attached cover: a simple visual for the biggest mistake people make with {{topic}}."],
      ["Chapter 3 opener", "In exactly the same style and palette as the attached cover: a simple visual for succeeding at {{topic}}."],
    ], "3:4", ["cover"]),
    ...finished(["cover", "page1", "page2", "page3"], "words", ["Finished cover", "Finished chapter 1", "Finished chapter 2", "Finished chapter 3"], { size: "book-a4", position: "top", style: "headline", font: "serif", colour: "light" }),
  ]),
  template("carousel", "social", "Social carousel", "Five slides with real words, ready to post", { brand: "a neighbourhood coffee roaster", topic: "how to brew better coffee at home", look: "warm morning light and earthy tones" }, [
    { id: "words", type: "text", label: "Slides", text: "A hook that stops the scroll\n---\nPoint one\n---\nPoint two\n---\nPoint three\n---\nWhat to do next", data: { brief: "Five carousel slides for {{brand}} about {{topic}}: a hook, three useful points and a call to action. Under ten words each." } },
    { id: "anchor", type: "image", label: "Slide 1 picture: approve this first", prompt: `A striking image about {{topic}} for {{brand}}: {{look}}. Editorial and uncluttered, the top third calm. ${NO_TEXT}`, ratio: "3:4" },
    ...pages([["Slide 2 picture", "Same look as the attached image: a close-up illustrating the first point."], ["Slide 3 picture", "Same look as the attached image: a different angle illustrating the second point."], ["Slide 4 picture", "Same look as the attached image: illustrating the third point."], ["Slide 5 picture", "Same look as the attached image: a calm, inviting final frame."]], "3:4", ["anchor"]),
    ...finished(["anchor", "page1", "page2", "page3", "page4"], "words", ["Slide 1", "Slide 2", "Slide 3", "Slide 4", "Slide 5"], { size: "social-portrait", position: "top", style: "headline", colour: "light" }),
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
  template("ad-test", "ads", "Ad test: four hooks", "One product, four angles with real headlines, see which wins", { audience: "busy commuters" }, [
    { id: "product", type: "source", label: "Your product photo (pick a file)" },
    { id: "words", type: "text", label: "Headlines", text: "The problem headline\n---\nThe outcome headline\n---\nThe proof headline\n---\nThe offer headline", data: { brief: "Four ad headlines for {{audience}}: one naming the problem, one the outcome, one with social proof and one with an offer. Under eight words each." } },
    ...pages([
      ["Hook 1: the problem", "The attached product shown beside the everyday frustration it fixes for {{audience}}. Calm space in the top third."],
      ["Hook 2: the outcome", "The attached product in the happy moment after the problem is gone, for {{audience}}. Bright and optimistic, calm space in the top third."],
      ["Hook 3: social proof", "A real-looking person from {{audience}} using the attached product, shot like a good phone photo."],
      ["Hook 4: the offer", "The attached product as a bold hero on a saturated background, calm space in the top third."],
    ].map(([l, p]) => [l!, `${p} ${NO_TEXT}`] as [string, string]), "1:1", ["product"]),
    ...finished(["page1", "page2", "page3", "page4"], "words", ["Ad 1", "Ad 2", "Ad 3", "Ad 4"], { size: "social-square", position: "top", style: "headline", colour: "light" }),
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
  template("youtube-thumbnails", "video", "YouTube thumbnails", "Three versions to test, with a title that stays readable", { title: "Bond gone in 5 years", topic: "how I paid off my bond in five years", person: "a man in his forties in a navy shirt", emotion: "genuine surprise" }, [
    { id: "base", type: "prompt", label: "Thumbnail style", text: `YouTube thumbnail about {{topic}}. High contrast, saturated colour, one clear subject that still reads at a very small size, the left half clean. ${NO_TEXT}` },
    { id: "words", type: "text", label: "Title on the thumbnail", text: "{{title}}", data: { brief: "A thumbnail title about {{topic}}: three to five punchy words, not the video's full title." } },
    { id: "face", type: "image", label: "Version A: face", prompt: "{{person}} on the right, showing {{emotion}}, looking straight at the camera, sharp and well lit.", ratio: "16:9", from: ["base"] },
    { id: "object", type: "image", label: "Version B: object", prompt: "One bold object that sums up the topic, huge in the frame on the right, with a dramatic glow.", ratio: "16:9", from: ["base"] },
    { id: "contrast", type: "image", label: "Version C: before and after", prompt: "A split frame on the right half: dull and cool on one side, bright and warm on the other, showing the change.", ratio: "16:9", from: ["base"] },
    ...["face", "object", "contrast"].map((picture, i): Step => ({ id: `done${i + 1}`, type: "layout", label: `Thumbnail ${"ABC"[i]}`, from: [picture, "words"], data: { size: "youtube", position: "middle", style: "headline", align: "left", scale: "l", colour: "light" } })),
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

/**
 * The nine-style pack as boards: reference image -> picture (the style's image JSON prompt) -> video 9:16 (its video JSON
 * prompt) -> a Layout cover set from the picture. The video card sets no duration, so Generate uses the chosen model's
 * own defaultDuration (generation.ts applyDuration).
 */
const STYLE_BOARDS: readonly CanvasTemplate[] = PROMPT_TEMPLATES.filter((t) => t.id.startsWith("style-") && t.spec).map((t) =>
  template(`${t.id}-board`, "video", t.title.replace(/ pair$/, ""), `${t.tagline}: reference, picture, video and cover`, t.examples ?? {}, [
    { id: "reference", type: "source", label: "Reference image (pick a file)" },
    { id: "frame", type: "image", label: "1. Picture", prompt: JSON.stringify(t.spec!.image, null, 2), ratio: "9:16", from: ["reference"] },
    { id: "clip", type: "video", label: "2. Video", prompt: JSON.stringify(t.spec!.video, null, 2), ratio: "9:16", from: ["frame"] },
    { id: "words", type: "text", label: "Cover title", text: "{{product}}", data: { brief: "A cover title for a short video about {{product}}: three to five punchy words." } },
    { id: "cover", type: "layout", label: "3. Cover", from: ["frame", "words"], data: { size: "social-story", position: "middle", style: "headline", scale: "l", colour: "light" } },
  ]),
);

export const CANVAS_TEMPLATES: readonly CanvasTemplate[] = [...CORE_BOARDS, ...STYLE_BOARDS];

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
