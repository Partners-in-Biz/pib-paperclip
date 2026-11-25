/** Draws a Layout card with the browser's canvas: the picture, then real text. The worker sends the picture's bytes, because storage links can't be read back from a canvas. */
import { loadedFamily } from "./font-names.js";
import { coverCrop, FONT_STACKS, planPage, type LayoutOptions, type PagePlan } from "../layout.js";

const images = new Map<string, Promise<HTMLImageElement>>();
const MAX_CACHED = 40;

/** One image per asset, kept for the page's life: a board redraws its previews often. */
export function loadAsset(assetId: string, fetchData: (assetId: string) => Promise<{ mime: string; base64: string }>): Promise<HTMLImageElement> {
  const cached = images.get(assetId);
  if (cached) return cached;
  const run = fetchData(assetId).then(
    ({ mime, base64 }) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("That picture could not be read."));
        img.src = `data:${mime};base64,${base64}`;
      }),
  );
  run.catch(() => images.delete(assetId));
  if (images.size >= MAX_CACHED) images.delete(images.keys().next().value as string);
  images.set(assetId, run);
  return run;
}

export function drawPage(canvas: HTMLCanvasElement, image: HTMLImageElement, text: string, width: number, height: number, options: LayoutOptions, scale = 1): PagePlan {
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the page.");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const weight = options.style === "headline" ? 700 : 400;
  const font = (size: number) => `${weight} ${size}px ${loadedFamily(options.font)}, ${FONT_STACKS[options.font]}`;
  const plan = planPage(width, height, text, options, (t, size) => {
    ctx.font = font(size);
    return ctx.measureText(t).width;
  });
  const light = options.colour === "light";
  ctx.fillStyle = light ? "#111111" : "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const crop = coverCrop(image.naturalWidth, image.naturalHeight, plan.image);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, plan.image.x, plan.image.y, plan.image.width, plan.image.height);
  if (plan.panel) {
    ctx.fillStyle = light ? "#141414" : "#fbf8f2";
    ctx.fillRect(plan.panel.x, plan.panel.y, plan.panel.width, plan.panel.height);
  }
  const shade = light ? "0,0,0" : "255,255,255";
  if (plan.fade) {
    const gradient = ctx.createLinearGradient(0, plan.fade.from, 0, plan.fade.to);
    gradient.addColorStop(0, `rgba(${shade},0.62)`);
    gradient.addColorStop(0.65, `rgba(${shade},0.42)`);
    gradient.addColorStop(1, `rgba(${shade},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, Math.min(plan.fade.from, plan.fade.to), width, Math.abs(plan.fade.to - plan.fade.from));
  } else if (!plan.panel) {
    const block = plan.lines.length * plan.lineHeight;
    ctx.fillStyle = `rgba(${shade},0.45)`;
    ctx.fillRect(0, plan.y - plan.fontSize, width, block + plan.fontSize * 2);
  }
  ctx.font = font(plan.fontSize);
  ctx.textAlign = options.align === "center" ? "center" : "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = light ? "#ffffff" : "#16130e";
  if (!plan.panel) {
    ctx.shadowColor = light ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.3)";
    ctx.shadowBlur = plan.fontSize * 0.12;
  }
  plan.lines.forEach((line, i) => ctx.fillText(line, plan.x, plan.y + i * plan.lineHeight));
  ctx.shadowBlur = 0;
  return plan;
}

/** The finished page as a JPEG, which every store and printer takes and stays small enough to save. */
export function pageJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error("This browser couldn't make the file."));
        else void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      },
      "image/jpeg",
      quality,
    );
  });
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(out);
}

export function saveFile(name: string, bytes: Uint8Array<ArrayBuffer>, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
