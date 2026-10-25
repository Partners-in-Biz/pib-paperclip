import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Voice",
  description:
    "A mic for voice notes and a waveform for live two-way talk with your agents, in every Paperclip chat box. Runs on Grok voice (xAI).",
  author: "Partners in Biz",
  categories: ["ui", "connector"],
  instanceConfigSchema,
  capabilities: [
    "agents.read",
    "http.outbound",
    "secrets.read-ref",
    "ui.action.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [
      {
        // One persistent mount; it places the buttons into each chat box on the page.
        type: "appShellOverlay",
        id: "voice-overlay",
        displayName: "Voice",
        exportName: "VoiceOverlay",
      },
    ],
  },
};

export default manifest;
