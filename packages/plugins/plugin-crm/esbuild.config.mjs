import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import { writeConnectorBundle } from "./scripts/connector-bundle.mjs";
import { writeRegisterDoc } from "./scripts/register-doc.mjs";

// The constants (version, zip sha256) must exist before the worker is bundled; the zip is written next to the page.
const zipPath = fileURLToPath(new URL("./dist/ui/pib-connector.zip", import.meta.url));
const bundle = await writeConnectorBundle(zipPath);
console.log(`PiB Connector ${bundle.version} sha256 ${bundle.sha256}`);

// The data-processing register is seeded from its docs file: embed it before the worker is bundled.
await writeRegisterDoc();

// The lead form files (the loader, the form page and an example) are served next to the page, as /_plugins/<uuid>/ui/<name>.
const staticDir = fileURLToPath(new URL("./static/", import.meta.url));
const uiDir = fileURLToPath(new URL("./dist/ui/", import.meta.url));
mkdirSync(uiDir, { recursive: true });
for (const name of readdirSync(staticDir)) cpSync(`${staticDir}${name}`, `${uiDir}${name}`);

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
