import esbuild from "esbuild";
import { cpSync } from "node:fs";
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

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
  // The prompt template gallery's example pictures, served from beside the page.
  cpSync(new URL("./assets/template-samples", import.meta.url), new URL("./dist/ui/template-samples", import.meta.url), { recursive: true });
}
