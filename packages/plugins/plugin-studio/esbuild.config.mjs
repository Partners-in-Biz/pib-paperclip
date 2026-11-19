import esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// The canvas page bundles React Flow (PAR-7750 settings): one unminified file, its CSS as text, and the old
// use-sync-external-store shim pointed at React's built-in hook so the host's React is the only copy.
const syncStoreShim = fileURLToPath(new URL("./src/ui/shims/use-sync-external-store.ts", import.meta.url));
const ui = {
  ...presets.esbuild.ui,
  minify: false,
  splitting: false,
  loader: { ".css": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "use-sync-external-store-shim",
      setup(build) {
        build.onResolve({ filter: /^use-sync-external-store(\/.*)?$/ }, () => ({ path: syncStoreShim }));
      },
    },
  ],
};

// The contained ML runner (PAR-10126 D5b): its own entry, the only code that loads onnxruntime-node. The worker bundle
// never imports it; the runtime resolves at run time from dist/ml/node_modules (copyMlRuntime below).
const mlRunner = {
  entryPoints: ["src/ml/runner.ts"],
  outfile: "dist/ml/runner.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  external: ["onnxruntime-node"],
};

// The deploy copies dist/ only and the live folder has no node_modules, so the runtime ships inside dist/ml: a pruned copy
// of onnxruntime-node + onnxruntime-common with only the linux-x64 CPU binaries (binding.js loads
// ../bin/napi-v6/<platform>/<arch>/, so that layout is kept), plus the two pinned models. bundle-size-guard.mjs checks it.
function copyMlRuntime() {
  const ml = fileURLToPath(new URL("./dist/ml/", import.meta.url));
  const models = fileURLToPath(new URL("./ml-models/", import.meta.url));
  for (const d of ["node_modules", "models"]) rmSync(join(ml, d), { recursive: true, force: true });
  // onnxruntime-common's `exports` hides package.json: resolve the entry and cut back to the package folder.
  const pkgDir = (from, name) => {
    const entry = createRequire(from).resolve(name);
    return entry.slice(0, entry.lastIndexOf(`/node_modules/${name}/`) + `/node_modules/${name}`.length);
  };
  const ortNode = pkgDir(import.meta.url, "onnxruntime-node");
  const ortCommon = pkgDir(join(ortNode, "package.json"), "onnxruntime-common");
  const outNode = join(ml, "node_modules/onnxruntime-node");
  const outCommon = join(ml, "node_modules/onnxruntime-common");
  const jsOnly = (src) => statSync(src).isDirectory() || src.endsWith(".js") || src.endsWith("package.json");
  cpSync(join(ortNode, "package.json"), join(outNode, "package.json"));
  cpSync(join(ortNode, "dist"), join(outNode, "dist"), { recursive: true, filter: jsOnly });
  for (const f of ["onnxruntime_binding.node", "libonnxruntime.so.1"]) cpSync(join(ortNode, "bin/napi-v6/linux/x64", f), join(outNode, "bin/napi-v6/linux/x64", f));
  cpSync(join(ortCommon, "package.json"), join(outCommon, "package.json"));
  cpSync(join(ortCommon, "dist/cjs"), join(outCommon, "dist/cjs"), { recursive: true, filter: jsOnly });
  for (const out of [outNode, outCommon]) cpSync(join(models, "onnxruntime.LICENSE"), join(out, "LICENSE"));
  cpSync(join(models, "onnxruntime.ThirdPartyNotices.txt"), join(outNode, "ThirdPartyNotices.txt"));
  mkdirSync(join(ml, "models"), { recursive: true });
  for (const f of readdirSync(models).filter((n) => n.endsWith(".onnx"))) {
    for (const g of [f, f.replace(/\.onnx$/, ".LICENSE")]) cpSync(join(models, g), join(ml, "models", g));
  }
  cpSync(join(models, "SHA256SUMS"), join(ml, "models/SHA256SUMS"));
}

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(ui);
const mlCtx = await esbuild.context(mlRunner);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch(), mlCtx.watch()]);
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild(), mlCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose(), mlCtx.dispose()]);
  copyMlRuntime();
  // The prompt template gallery's example pictures, served from beside the page.
  cpSync(new URL("./assets/template-samples", import.meta.url), new URL("./dist/ui/template-samples", import.meta.url), { recursive: true });
  // The video renderer's OFL fonts (+ OFL.txt) beside dist/worker.js, where src/video-edit/fonts.ts looks for them;
  // dist/ui/fonts is the same set for the browser editor (Phase B) to load with FontFace.
  cpSync(new URL("./fonts", import.meta.url), new URL("./dist/fonts", import.meta.url), { recursive: true });
  cpSync(new URL("./fonts", import.meta.url), new URL("./dist/ui/fonts", import.meta.url), { recursive: true });
  // The sticker packs (PAR-10172 D4b): dist/stickers is what the render reads (src/video-edit/stickers.ts); dist/ui/stickers
  // is the same set for the browser preview. Closed manifest, so only listed files are ever opened.
  cpSync(new URL("./stickers", import.meta.url), new URL("./dist/stickers", import.meta.url), { recursive: true });
  cpSync(new URL("./stickers", import.meta.url), new URL("./dist/ui/stickers", import.meta.url), { recursive: true });
}
