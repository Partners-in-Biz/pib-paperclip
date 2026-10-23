import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFile } from "node:fs/promises";

const __dir = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Copy the push service worker to the UI distribution.
const copySW = async () => {
  const uiDir = join(__dir, "dist", "ui");
  mkdirSync(uiDir, { recursive: true });
  await copyFile(join(__dir, "src", "ui-static", "push-sw.js"), join(uiDir, "push-sw.js"));
};

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  await copySW();
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await copySW();
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
