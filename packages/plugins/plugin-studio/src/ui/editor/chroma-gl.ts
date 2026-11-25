/**
 * Preview chroma key (PAR-8279 slice 3, D3d2): the WebGL side of `video-edit/chroma.ts`. Every number the shader uses
 * comes from that module (`keyYuv`, `keyMatrix`, `spillScreen`, `COEFFS`), so the render's `chromakey` + `despill` and
 * the preview read one definition. The fragment shader is the per-pixel form of `keyDistance` (3x3 mean; a neighbour
 * off the frame counts as the key colour, as in vf_chromakey.c), `keyCoverage` and `despillRgb`, run on the decoded RGB
 * turned back into TV-range Cb/Cr with the clip's matrix. `keyPixel` is the same maths in JS for the tests. Output is
 * premultiplied (the canvas default). No React here; `ChromaLayer.tsx` mounts it.
 */
import { COEFFS, keyMatrix, keyYuv, spillScreen, type Rgb, type YuvMatrix } from "../../video-edit/chroma.js";
import type { ChromaKey } from "../../video-edit/timeline.js";

/** Shown on an overlay whose key the browser cannot draw (no WebGL): the clip plays unkeyed. */
export const NO_KEY_LABEL = "Preview without key";

export interface ChromaUniforms {
  /** Key Cb, Cr codes. */
  key: [number, number];
  /** Cb = 128 + dot(rgb, cb), Cr = 128 + dot(rgb, cr), rgb in 0..1: `rgbToYuv`'s chroma rows (TV range). */
  cb: Rgb;
  cr: Rgb;
  similarity: number;
  /** 0 means the hard step (`keyCoverage` with blend <= 0.0001). */
  blend: number;
  /** Despill amount, 0 when `despillRgb` is the identity (spill 0 or a key that is not a green/blue screen). */
  spill: number;
  /** 1: green screen (G cleaned against R, B); 0: blue (B against R, G). */
  green: number;
}

/** The shader's uniforms for a clip's key. `isImage`/`graded` pick the matrix as the render does (`keyMatrix`). */
export function chromaUniforms(k: ChromaKey, isImage = false, graded = false): ChromaUniforms {
  const matrix: YuvMatrix = keyMatrix(isImage, graded);
  const [kr, kb] = COEFFS[matrix];
  const kg = 1 - kr - kb;
  const u = 112 / (1 - kb), v = 112 / (1 - kr);
  const [, ku, kv] = keyYuv(k, matrix);
  const screen = spillScreen(k);
  return {
    key: [ku, kv],
    cb: [-kr * u, -kg * u, 112],
    cr: [112, -kg * v, -kb * v],
    similarity: k.similarity,
    blend: k.blend > 0.0001 ? k.blend : 0,
    spill: screen ? k.spill : 0,
    green: screen === "green" ? 1 : 0,
  };
}

const dot = (a: Rgb, b: Rgb) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * One output pixel, as the shader computes it: `rgb` is the pixel (0..1), `around` its 9 neighbours row by row
 * (null = off the frame). Returns straight (not premultiplied) RGB and alpha, each truncated to an 8-bit code.
 */
export function keyPixel(p: ChromaUniforms, rgb: Rgb, around: readonly (Rgb | null)[]): [number, number, number, number] {
  let sum = 0;
  for (const n of around) {
    if (!n) continue;
    const du = 128 + dot(n, p.cb) - p.key[0], dv = 128 + dot(n, p.cr) - p.key[1];
    sum += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
  }
  const d = sum / 9;
  const a = p.blend > 0 ? Math.min(1, Math.max(0, (d - p.similarity) / p.blend)) : d > p.similarity ? 1 : 0;
  let [r, g, b] = rgb;
  if (p.spill > 0) {
    if (p.green) g = Math.max(0, g - p.spill * Math.max(0, g - (r + b) * 0.5));
    else b = Math.max(0, b - p.spill * Math.max(0, b - (r + g) * 0.5));
  }
  const code = (c: number) => Math.floor(Math.min(1, c) * 255) / 255;
  return [code(r), code(g), code(b), code(a)];
}

export const VERTEX_SHADER = `attribute vec2 pos;
varying vec2 uv;
void main() { uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5); gl_Position = vec4(pos, 0.0, 1.0); }`;

/** `keyPixel` in GLSL ES 1.0. `texel` is one source pixel in texture coordinates. */
export const FRAGMENT_SHADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D frame;
uniform vec2 texel;
uniform vec2 keyUv;
uniform vec3 cbRow;
uniform vec3 crRow;
uniform float similarity;
uniform float blend;
uniform float spill;
uniform float green;
void main() {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 at = uv + vec2(float(x), float(y)) * texel;
    if (at.x < 0.0 || at.y < 0.0 || at.x > 1.0 || at.y > 1.0) continue;
    vec3 n = texture2D(frame, at).rgb;
    vec2 d = vec2(128.0 + dot(n, cbRow), 128.0 + dot(n, crRow)) - keyUv;
    sum += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
  }
  float dist = sum / 9.0;
  float a = blend > 0.0 ? clamp((dist - similarity) / blend, 0.0, 1.0) : (dist > similarity ? 1.0 : 0.0);
  vec3 c = texture2D(frame, uv).rgb;
  if (spill > 0.0) {
    if (green > 0.5) c.g = max(0.0, c.g - spill * max(0.0, c.g - (c.r + c.b) * 0.5));
    else c.b = max(0.0, c.b - spill * max(0.0, c.b - (c.r + c.g) * 0.5));
  }
  c = floor(min(c, 1.0) * 255.0) / 255.0;
  a = floor(a * 255.0) / 255.0;
  gl_FragColor = vec4(c * a, a);
}`;

/** The canvas context getter, narrowed so the tests can pass a fake. */
export interface CanvasLike {
  getContext(id: "webgl", attrs?: WebGLContextAttributes): WebGLRenderingContext | null;
}

export interface ChromaGl {
  /** Draws the video's current frame keyed (with `u` when the key changed); sizes the canvas to the frame. False if not ready. */
  draw(video: HTMLVideoElement, canvas: HTMLCanvasElement, u?: ChromaUniforms): boolean;
  dispose(): void;
}

/** Sets WebGL up for a key, or null when the browser has no WebGL or the shader does not build (the caller falls back). */
export function createChromaGl(canvas: CanvasLike, p: ChromaUniforms): ChromaGl | null {
  let ctx: WebGLRenderingContext | null = null;
  try {
    ctx = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false, antialias: false });
  } catch {
    return null;
  }
  if (!ctx) return null;
  const gl = ctx;
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX_SHADER), fs = shader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const prog = vs && fs ? gl.createProgram() : null;
  if (!prog || !vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, "pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // NEAREST: each tap reads one decoded pixel, as `chromakey` reads one sample per neighbour.
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const at = (n: string) => gl.getUniformLocation(prog, n);
  const [keyUv, cbRow, crRow, similarity, blend, spill, green, texel] = ["keyUv", "cbRow", "crRow", "similarity", "blend", "spill", "green", "texel"].map(at);
  let set = "";
  const uniforms = (u: ChromaUniforms) => {
    const id = JSON.stringify(u);
    if (id === set) return;
    set = id;
    gl.uniform2f(keyUv, u.key[0], u.key[1]);
    gl.uniform3f(cbRow, ...u.cb);
    gl.uniform3f(crRow, ...u.cr);
    gl.uniform1f(similarity, u.similarity);
    gl.uniform1f(blend, u.blend);
    gl.uniform1f(spill, u.spill);
    gl.uniform1f(green, u.green);
  };
  uniforms(p);
  return {
    draw(video, el, u = p) {
      const w = video.videoWidth, h = video.videoHeight;
      if (video.readyState < 2 || !w || !h || gl.isContextLost()) return false;
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      uniforms(u);
      gl.viewport(0, 0, w, h);
      gl.uniform2f(texel, 1 / w, 1 / h);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}

export type ChromaStatus = "gl" | "none";

/** The browser hooks the draw loop needs; the tests pass fakes. */
export interface ChromaLoopDeps {
  create?: (canvas: HTMLCanvasElement, p: ChromaUniforms) => ChromaGl | null;
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
}

/**
 * Keys `video` onto `canvas` on every new frame and returns the cleanup. Reports "gl" while it draws and "none" (the
 * caller shows the clip unkeyed under `NO_KEY_LABEL`) when WebGL is missing, the context is lost, or a draw throws.
 * A draw throws when the video is cross-origin without CORS (a presigned R2 link): WebGL refuses the tainted upload
 * with a SecurityError on every frame, so the loop stops at the first throw instead of leaving the clip invisible.
 */
export function startChromaLoop(canvas: HTMLCanvasElement, video: HTMLVideoElement, uniforms: () => ChromaUniforms, onStatus: (s: ChromaStatus) => void, deps: ChromaLoopDeps = {}): () => void {
  const { create = createChromaGl, raf = requestAnimationFrame, caf = cancelAnimationFrame } = deps;
  const gl = create(canvas, uniforms());
  if (!gl) {
    onStatus("none");
    return () => {};
  }
  onStatus("gl");
  // Draw when the frame may have changed: every animation frame while playing, else when time, seek or size moves.
  let last = "", id = 0, stopped = false;
  const stop = () => {
    stopped = true;
    caf(id);
  };
  const tick = () => {
    if (stopped) return;
    const u = uniforms();
    const at = `${video.currentTime}|${video.seeking}|${video.readyState}|${video.videoWidth}|${JSON.stringify(u)}`;
    try {
      if ((!video.paused || at !== last) && !video.seeking && gl.draw(video, canvas, u)) last = at;
    } catch {
      stop();
      onStatus("none");
      return;
    }
    id = raf(tick);
  };
  id = raf(tick);
  const lost = (e: Event) => {
    e.preventDefault();
    stop();
    onStatus("none");
  };
  canvas.addEventListener("webglcontextlost", lost);
  return () => {
    stop();
    canvas.removeEventListener("webglcontextlost", lost);
    gl.dispose();
  };
}
