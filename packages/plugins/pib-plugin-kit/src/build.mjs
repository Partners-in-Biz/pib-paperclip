/**
 * Build helper for plugin esbuild configs.
 *
 * `buildOauthBridge({ outdir: "dist/ui", title: "Social" })` writes
 * `oauth-callback.html` + `oauth-callback.js` into the plugin's UI folder. The
 * host serves them publicly at `/_plugins/<pluginId>/ui/oauth-callback.html`,
 * which is the redirect URI to register with each OAuth provider.
 */
import esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function buildOauthBridge({ outdir, title = "Connect account" }) {
  await mkdir(outdir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(here, "oauth-bridge", "callback.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    outfile: path.join(outdir, "oauth-callback.js"),
    logLevel: "warning",
  });
  const template = await readFile(path.join(here, "oauth-bridge", "callback.html"), "utf8");
  const safeTitle = String(title).replace(/[<>&"]/g, "");
  await writeFile(path.join(outdir, "oauth-callback.html"), template.replace("{{TITLE}}", safeTitle), "utf8");
}
