import type { PipelineStep, PipelineStepCtx } from "./pipeline.js";

export interface TranscribeDeps {
  audioUrl: (sc: PipelineStepCtx) => Promise<string>;
}

interface DeepgramUtterance {
  channel?: number;
  start?: number;
  end?: number;
  transcript?: string;
}

interface DeepgramResponse {
  results?: { utterances?: DeepgramUtterance[] };
}

interface TranscriptSegment {
  channel: number;
  start: number;
  end: number;
  text: string;
}

export function makeTranscribeStep(deps: TranscribeDeps): PipelineStep {
  return async (sc: PipelineStepCtx) => {
    const { ctx, namespace, row } = sc;

    // Re-check erasure
    const erasureCheck = await ctx.db.query<{ erased_at: string | null }>(
      `SELECT erased_at FROM ${namespace}.tel_recordings WHERE id = $1::uuid`,
      [row.id],
    );
    if (erasureCheck.length === 0 || erasureCheck[0].erased_at) return { state: "erased" };

    // Get call details and language preference
    const callRows = await ctx.db.query<{ company_id: string; contact_id: string | null }>(
      `SELECT company_id, contact_id FROM ${namespace}.tel_calls WHERE call_sid = $1`,
      [row.call_sid],
    );

    const companyId = (row as any).company_id || callRows[0]?.company_id;
    const contactId = callRows[0]?.contact_id;

    if (!companyId) throw new Error("call not found");

    let language = "en";
    if (contactId) {
      const prefRows = await ctx.db.query<{ language: string | null }>(
        `SELECT language FROM ${namespace}.tel_contact_prefs WHERE company_id = $1 AND contact_id = $2`,
        [companyId, contactId],
      );
      if (prefRows.length > 0 && prefRows[0].language) {
        language = prefRows[0].language;
      }
    }

    // Resolve Deepgram API key
    const apiKey = await ctx.secrets.resolve("DEEPGRAM_API_KEY", { companyId });
    if (!apiKey) throw new Error("DEEPGRAM_API_KEY not set");

    // Get audio URL and extend lease
    const audioUrl = await deps.audioUrl(sc);
    await sc.extendLease();

    // Call Deepgram API
    const deepgramUrl = `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}&multichannel=true&smart_format=true&utterances=true`;
    const response = await ctx.http.fetch(deepgramUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: audioUrl }),
    });

    if (!response.ok) throw new Error(`deepgram http ${response.status}`);

    const data = (await response.json()) as DeepgramResponse;

    // Parse utterances
    const utterances = data.results?.utterances ?? [];
    const segments: TranscriptSegment[] = [];
    const lines: string[] = [];

    for (const u of utterances) {
      if (!u.transcript) continue;
      const channel = u.channel ?? 0;
      const text = u.transcript;
      if (u.start !== undefined && u.end !== undefined) {
        segments.push({ channel, start: u.start, end: u.end, text });
      }
      const label = channel === 1 ? "Contact" : "Agent";
      lines.push(`${label}: ${text}`);
    }

    const fullText = lines.join("\n");

    // Insert transcript (idempotent, erasure-safe)
    const insertResult = await ctx.db.execute(
      `INSERT INTO ${namespace}.tel_transcripts (recording_id, call_sid, provider, language, text, segments)
       SELECT r.id, r.call_sid, 'deepgram', $2, $3, $4::jsonb
       FROM ${namespace}.tel_recordings r
       WHERE r.id = $1::uuid AND r.erased_at IS NULL
       ON CONFLICT (recording_id) DO UPDATE SET language = EXCLUDED.language, text = EXCLUDED.text, segments = EXCLUDED.segments, updated_at = now()`,
      [row.id, language, fullText, JSON.stringify(segments)],
    );

    if (insertResult.rowCount === 0) return { state: "erased" };

    return { state: "transcribed" };
  };
}
