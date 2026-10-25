import { describe, expect, it, vi } from "vitest";
import { MAX_AUDIO_BYTES, mintLiveToken, transcribe, VoiceError } from "../src/xai.js";
import { XAI_CLIENT_SECRETS_URL, XAI_STT_URL } from "../src/namespace.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("transcribe", () => {
  it("posts options before the file, with every keyterm", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ text: " Ask the SEO Specialist. ", duration: 2.5 }),
    );
    const result = await transcribe(
      { apiKey: "k", audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4;codecs=mp4a", language: "en", keyterms: ["SEO", "Kai"] },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ text: "Ask the SEO Specialist.", duration: 2.5 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(XAI_STT_URL);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const form = init!.body as FormData;
    const keys = [...form.keys()];
    expect(keys[keys.length - 1]).toBe("file");
    expect(form.getAll("keyterm")).toEqual(["SEO", "Kai"]);
    expect(form.get("language")).toBe("en");
    expect(form.get("format")).toBe("true");
    expect((form.get("file") as File).name).toBe("note.m4a");
  });

  it("skips language and format when no language is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "hi" }));
    await transcribe({ apiKey: "k", audio: new Uint8Array([1]), mimeType: "audio/webm" }, fetchImpl as unknown as typeof fetch);
    const form = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.has("language")).toBe(false);
    expect(form.has("format")).toBe(false);
  });

  it("refuses unknown types, empty and oversized audio without calling xAI", async () => {
    const fetchImpl = vi.fn();
    const f = fetchImpl as unknown as typeof fetch;
    await expect(transcribe({ apiKey: "k", audio: new Uint8Array([1]), mimeType: "video/mp4" }, f)).rejects.toThrow(/Unsupported audio/);
    await expect(transcribe({ apiKey: "k", audio: new Uint8Array(), mimeType: "audio/mp4" }, f)).rejects.toThrow(/empty/);
    await expect(
      transcribe({ apiKey: "k", audio: new Uint8Array(MAX_AUDIO_BYTES + 1), mimeType: "audio/mp4" }, f),
    ).rejects.toThrow(/too long/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains auth failures and scrubs key-like strings from xAI errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Incorrect API key xai-ABCDEFGHIJKLMNOP provided" }, 401));
    const err = await transcribe({ apiKey: "k", audio: new Uint8Array([1]), mimeType: "audio/mp4" }, fetchImpl as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect(err.message).toContain("401");
    expect(err.message).toContain("Check the xAI key");
    expect(err.message).not.toContain("ABCDEFGHIJKLMNOP");
  });
});

describe("mintLiveToken", () => {
  it("asks for a short-lived client secret and returns it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ value: "eph", expires_at: 123 }));
    const out = await mintLiveToken("k", 300, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ token: "eph", expiresAt: 123 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(XAI_CLIENT_SECRETS_URL);
    expect(JSON.parse(String(init.body))).toEqual({ expires_after: { seconds: 300 } });
  });

  it("says when xAI is out of credit", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "quota" }, 429));
    await expect(mintLiveToken("k", 300, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/out of credit/);
  });

  it("fails clearly on an empty token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(mintLiveToken("k", 300, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/no session token/);
  });
});
