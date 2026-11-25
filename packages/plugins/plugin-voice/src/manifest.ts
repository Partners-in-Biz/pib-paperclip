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
    // A3 (PAR-12643): the access guard reads the caller's role, and its receiver takes grants from Setup by event
    // and confirms them. New capabilities: a stop-first deploy.
    "access.members.read",
    "agents.read",
    "events.subscribe",
    "events.emit",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
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
