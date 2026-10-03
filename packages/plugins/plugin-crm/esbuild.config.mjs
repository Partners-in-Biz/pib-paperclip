import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { writeConnectorBundle } from "./scripts/connector-bundle.mjs";

// The constants (version, zip sha256) must exist before the worker is bundled; the zip is written next to the page.
const zipPath = fileURLToPath(new URL("./dist/ui/pib-connector.zip", import.meta.url));
const bundle = await writeConnectorBundle(zipPath);
console.log(`PiB Connector ${bundle.version} sha256 ${bundle.sha256}`);

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}

// The PiB Connector zip (built above) is served next to the page (Websites → Connect WordPress).
