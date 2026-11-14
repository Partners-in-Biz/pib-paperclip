// Fails the build when fonts leak into the UI bundle (B12). The OFL TTFs are served files under dist/ui/fonts, loaded
// with FontFace by URL; inlining them (data URL / base64 / .ttf import) would bloat dist/ui/index.js.
// BUDGET is the bundle size with the font loader in, plus 50 KB of headroom for fonts; raise it only with a reason.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkMlDist, ML_BUDGET, mlBytes } from "./ml-dist-check.mjs";

// 2026-11-08: raised to 1,050,000 for Studio 0.1.49 (lip-sync form, ClipInspector, transition picker, keyframe preview
// grew the UI to 956,057 bytes with no font inlined; the font checks below still guard that). Next growth still fails loudly.
const BUDGET = 1_050_000; // bytes; was 950,000 (897,553 before B12 + ~2 KB loader + 50 KB)
const bundle = new URL("../dist/ui/index.js", import.meta.url);
const fontsDir = new URL("../dist/ui/fonts/", import.meta.url);
const size = statSync(bundle).size;
const src = readFileSync(bundle, "utf8");
const problems = [];
if (size > BUDGET) problems.push(`dist/ui/index.js is ${size} bytes, over the ${BUDGET} budget`);
if (/data:(font|application\/(font|x-font|octet-stream))[^"']{0,40}base64/i.test(src) || /AAEAAAA[A-Za-z0-9+/]{200}/.test(src)) problems.push("a font looks inlined into dist/ui/index.js (data URL / base64 TTF)");
const files = readdirSync(fontsDir).filter((f) => f.endsWith(".ttf"));
// The six names UI_FONTS (src/ui/font-names.ts) loads: a wrong or missing file fails here, not in a user's browser.
const expected = [...readFileSync(new URL("../src/ui/font-names.ts", import.meta.url), "utf8").matchAll(/"([\w-]+\.ttf)"/g)].map((m) => m[1]).sort();
if (expected.length !== 6) problems.push(`found ${expected.length} font names in src/ui/font-names.ts, expected 6`);
if (JSON.stringify([...files].sort()) !== JSON.stringify(expected)) problems.push(`dist/ui/fonts has [${files}], expected [${expected}]`);
// The ML runtime under dist/ml (PAR-10126 D5b): CUDA/TensorRT, non-linux-x64 binaries, model hashes, the 60 MB cap.
// The sticker packs (PAR-10172 D4b): dist/stickers and dist/ui/stickers hold exactly the manifest's files, and the two
// copies together add at most 8 MB.
const STICKER_BUDGET = 8 * 1024 * 1024;
const manifestSrc = readFileSync(new URL("../src/video-edit/sticker-packs.ts", import.meta.url), "utf8");
const noto = manifestSrc.slice(manifestSrc.indexOf("const NOTO_EMOJI"), manifestSrc.indexOf("const PIB_SHAPES"));
const shapes = manifestSrc.slice(manifestSrc.indexOf("const PIB_SHAPES"), manifestSrc.indexOf("const MANIFEST"));
const idsOf = (block, value) => [...block.matchAll(new RegExp(`(?:"([\\w-]+)"|(\\b\\w+)): ${value}`, "g"))].map((m) => `${m[1] ?? m[2]}.png`).sort();
let stickerBytes = 0;
for (const root of ["../dist/stickers/", "../dist/ui/stickers/"]) {
  for (const [pack, want] of [["noto-emoji", idsOf(noto, '"[0-9a-f]+"')], ["pib-shapes", idsOf(shapes, '"[A-Z][^"]*"')]]) {
    const dir = new URL(`${root}${pack}/`, import.meta.url);
    const have = readdirSync(dir).sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) problems.push(`${root}${pack} has ${have.length} files, the manifest lists ${want.length}`);
    for (const f of have) stickerBytes += statSync(new URL(f, dir)).size;
  }
}
if (stickerBytes > STICKER_BUDGET) problems.push(`the sticker packs add ${stickerBytes} bytes (both copies), over the ${STICKER_BUDGET} budget`);
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
problems.push(...checkMlDist({ distDir, sumsFile: fileURLToPath(new URL("../ml-models/SHA256SUMS", import.meta.url)) }));
if (problems.length) {
  console.error(`BUNDLE-SIZE-CHECK: FAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`BUNDLE-SIZE-CHECK: PASS (dist/ui/index.js ${size} bytes of ${BUDGET}; ${files.length} served TTFs; dist/ml ${mlBytes(distDir)} bytes of ${ML_BUDGET}; stickers ${stickerBytes} bytes of ${STICKER_BUDGET})`);
