/**
 * PAR-10040: tests never reach the live preview render service.
 *
 * create-preview asks `PREVIEW_RENDER_URL` (127.0.0.1:3033) for the rendered page through `env.fetch`, and
 * `createEnv` defaults that to the real `fetch`. On the VPS and the deploy gate the real pib-preview service listens
 * there, so a test without a `fetch` stub ran a real Chrome render (and waited out 503 "busy" retries): 3 to 5 s per
 * call, over the 5 s test timeout under load. Here the loopback render URL fails fast, as an unreachable service does,
 * and create-preview builds from the source. A test that needs a render stubs `env.fetch` (or `fetch`) itself.
 */
import { PREVIEW_RENDER_URL } from "../../src/service/preview-links.js";

const RENDER_ORIGIN = new URL(PREVIEW_RENDER_URL).origin;
const realFetch = globalThis.fetch;

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  let origin: string | null = null;
  try {
    origin = new URL(urlOf(input)).origin;
  } catch {
    // not an absolute URL: let the real fetch report it
  }
  if (origin === RENDER_ORIGIN) {
    throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${RENDER_ORIGIN} (the live preview service is off limits in tests)`) });
  }
  return realFetch(input, init);
}) as typeof fetch;
