// Draws the `pib-shapes` sticker pack (src/video-edit/sticker-packs.ts PIB_SHAPES) to stickers/pib-shapes/<id>.png.
// No dependencies: each shape is an inside() test on [-1,1]^2 with 4x4 supersampling, written as an RGBA PNG by hand.
// Run: node scripts/gen-pib-shapes.mjs (output is committed; a spec checks every manifest id has a file).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 256;
const SS = 4;
const OUT = new URL("../stickers/pib-shapes/", import.meta.url);

const poly = (pts) => (x, y) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const rot = (pts, a) => pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
const star = (n, ro, ri) => poly(Array.from({ length: n * 2 }, (_, i) => { const a = (Math.PI * i) / n - Math.PI / 2, r = i % 2 ? ri : ro; return [r * Math.cos(a), r * Math.sin(a)]; }));
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const rrect = (h, r) => (x, y) => { const dx = Math.max(Math.abs(x) - (h - r), 0), dy = Math.max(Math.abs(y) - (h - r), 0); return dx * dx + dy * dy <= r * r; };
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const or = (...f) => (x, y) => f.some((g) => g(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);
const arrow = (a) => poly(rot([[-0.9, -0.28], [0.1, -0.28], [0.1, -0.7], [0.9, 0], [0.1, 0.7], [0.1, 0.28], [-0.9, 0.28]], a));
const bubble = (tail) => or(rrect(0.9, 0.35), poly(tail));

const SHAPES = {
  circle: [circle(0, 0, 0.9), "#ffc400"],
  ring: [minus(circle(0, 0, 0.9), circle(0, 0, 0.62)), "#ffc400"],
  square: [rect(-0.8, -0.8, 0.8, 0.8), "#ff5a5f"],
  "rounded-square": [rrect(0.85, 0.28), "#ff5a5f"],
  triangle: [poly([[0, -0.9], [0.9, 0.7], [-0.9, 0.7]]), "#2ec4b6"],
  diamond: [poly([[0, -0.95], [0.75, 0], [0, 0.95], [-0.75, 0]]), "#2ec4b6"],
  star: [star(5, 0.95, 0.4), "#ffc400"],
  heart: [(x, y) => { const u = x * 1.15, v = -y * 1.15 + 0.1; return (u * u + v * v - 1) ** 3 - u * u * v ** 3 <= 0; }, "#ff3b6b"],
  burst: [star(12, 0.95, 0.68), "#ff8a00"],
  "speech-bubble": [bubble([[-0.6, 0.3], [-0.55, 0.95], [-0.05, 0.3]]), "#ffffff"],
  "thought-bubble": [or(rrect(0.9, 0.45), circle(-0.55, 0.62, 0.14), circle(-0.8, 0.88, 0.08)), "#ffffff"],
  "arrow-right": [arrow(0), "#2ec4b6"],
  "arrow-left": [arrow(Math.PI), "#2ec4b6"],
  "arrow-up": [arrow(-Math.PI / 2), "#2ec4b6"],
  "arrow-down": [arrow(Math.PI / 2), "#2ec4b6"],
  "curved-arrow": [or((x, y) => { const r = Math.hypot(x, y + 0.2); return r >= 0.5 && r <= 0.72 && y + 0.2 <= 0 && x > -0.75; }, poly([[0.3, -0.2], [0.92, -0.2], [0.61, 0.3]])), "#ff8a00"],
  check: [poly([[-0.85, 0.05], [-0.6, -0.2], [-0.25, 0.2], [0.6, -0.7], [0.85, -0.45], [-0.25, 0.72]]), "#2ec4b6"],
  cross: [poly(rot([[-0.2, -0.85], [0.2, -0.85], [0.2, -0.2], [0.85, -0.2], [0.85, 0.2], [0.2, 0.2], [0.2, 0.85], [-0.2, 0.85], [-0.2, 0.2], [-0.85, 0.2], [-0.85, -0.2], [-0.2, -0.2]], Math.PI / 4)), "#ff3b6b"],
  plus: [or(rect(-0.2, -0.8, 0.2, 0.8), rect(-0.8, -0.2, 0.8, 0.2)), "#2ec4b6"],
  underline: [rrect2(0.95, 0.12, 0.62), "#ffc400"],
  "scribble-circle": [(x, y) => { const r = Math.hypot(x, y), a = Math.atan2(y, x); const target = 0.68 + 0.08 * Math.sin(a * 2) + 0.06 * Math.cos(a); return Math.abs(r - target) <= 0.07; }, "#ff3b6b"],
  "highlight-bar": [rect(-0.95, -0.3, 0.95, 0.3), "#ffe14d"],
  "price-tag": [minus(poly([[-0.9, -0.55], [0.35, -0.55], [0.95, 0], [0.35, 0.55], [-0.9, 0.55]]), circle(0.45, 0, 0.1)), "#ff8a00"],
  badge: [minus(star(16, 0.95, 0.82), circle(0, 0, 0.45)), "#ffc400"],
};
function rrect2(hw, hh, y0) { return (x, y) => { const dx = Math.max(Math.abs(x) - (hw - hh), 0), dy = Math.abs(y - y0); return dx * dx + dy * dy <= hh * hh; }; }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
};
function png(rgba) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(SIZE, 0); head.writeUInt32BE(SIZE, 4); head[8] = 8; head[9] = 6;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// The ids come from the manifest, so a shape cannot be drawn without being listed (and the reverse fails loudly).
const manifest = readFileSync(new URL("../src/video-edit/sticker-packs.ts", import.meta.url), "utf8");
const listed = [...manifest.slice(manifest.indexOf("PIB_SHAPES")).matchAll(/(?:"([\w-]+)"|(\b\w+)): "[A-Z][^"]*"/g)].map((m) => m[1] ?? m[2]);
if (JSON.stringify([...listed].sort()) !== JSON.stringify(Object.keys(SHAPES).sort())) throw new Error(`manifest ids [${listed}] differ from drawn shapes [${Object.keys(SHAPES)}]`);

mkdirSync(OUT, { recursive: true });
for (const [id, [inside, hex]] of Object.entries(SHAPES)) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let py = 0; py < SIZE; py++) for (let pxl = 0; pxl < SIZE; pxl++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (inside(((pxl + (sx + 0.5) / SS) / SIZE) * 2 - 1, ((py + (sy + 0.5) / SS) / SIZE) * 2 - 1)) hit++;
    }
    const o = (py * SIZE + pxl) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round((hit / (SS * SS)) * 255);
  }
  writeFileSync(new URL(`${id}.png`, OUT), png(px));
}
console.log(`wrote ${Object.keys(SHAPES).length} shapes to stickers/pib-shapes`);
