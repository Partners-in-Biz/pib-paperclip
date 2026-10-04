import type { StoredPlatform } from "../platforms.js";
import { googleProvider } from "./google.js";
import { metaProvider } from "./meta.js";
import { MockAdsProvider } from "./mock.js";
import type { AdsProvider } from "./types.js";

let demo: MockAdsProvider | null = null;

/** The real adapters, and the one shared demo provider behind the test platform. Tests hand their own provider to the services instead. */
export function realProvider(platform: StoredPlatform): AdsProvider {
  if (platform === "meta") return metaProvider;
  if (platform === "google") return googleProvider;
  demo ??= new MockAdsProvider("mock", { demo: true });
  return demo;
}
