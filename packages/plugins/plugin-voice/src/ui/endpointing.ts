/**
 * Level-based utterance endpointing for direct voice mode (plan PAR-14808, T3). Fed one level per
 * audio frame with that frame's length in ms, so it is deterministic and needs no timers.
 * Values come from `src/limits.ts`.
 */
import {
  BARGE_IN_LEVEL_FACTOR,
  BARGE_IN_MS,
  ENDPOINT_END_QUIET_MS,
  ENDPOINT_MAX_UTTERANCE_MS,
  ENDPOINT_SPEECH_LEVEL,
  ENDPOINT_START_MS,
} from "../limits.js";

export type EndpointEvent = "start" | "end" | "cap" | null;

export interface EndpointOptions {
  speechLevel?: number;
  startMs?: number;
  endQuietMs?: number;
  maxUtteranceMs?: number;
}

export class Endpointer {
  private readonly speechLevel: number;
  private readonly startMs: number;
  private readonly endQuietMs: number;
  private readonly maxUtteranceMs: number;
  private speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private utteranceMs = 0;

  constructor(opts: EndpointOptions = {}) {
    this.speechLevel = opts.speechLevel ?? ENDPOINT_SPEECH_LEVEL;
    this.startMs = opts.startMs ?? ENDPOINT_START_MS;
    this.endQuietMs = opts.endQuietMs ?? ENDPOINT_END_QUIET_MS;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? ENDPOINT_MAX_UTTERANCE_MS;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** `start` once speech held for the start time; `end` after the quiet time; `cap` at the hard limit. */
  push(level: number, frameMs: number): EndpointEvent {
    const loud = level >= this.speechLevel;
    if (!this.speaking) {
      this.loudMs = loud ? this.loudMs + frameMs : 0; // a short burst (cough, click) resets here
      if (this.loudMs < this.startMs) return null;
      this.speaking = true;
      this.utteranceMs = this.loudMs;
      this.quietMs = 0;
      return "start";
    }
    this.utteranceMs += frameMs;
    this.quietMs = loud ? 0 : this.quietMs + frameMs;
    if (this.utteranceMs >= this.maxUtteranceMs) {
      this.reset();
      return "cap";
    }
    if (this.quietMs >= this.endQuietMs) {
      this.reset();
      return "end";
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.utteranceMs = 0;
  }
}

/** Barge-in while the agent speaks: a level well above the speech level for a short while. */
export class BargeInDetector {
  private loudMs = 0;
  private readonly threshold: number;
  private readonly holdMs: number;

  constructor(opts: { speechLevel?: number; factor?: number; holdMs?: number } = {}) {
    this.threshold = (opts.speechLevel ?? ENDPOINT_SPEECH_LEVEL) * (opts.factor ?? BARGE_IN_LEVEL_FACTOR);
    this.holdMs = opts.holdMs ?? BARGE_IN_MS;
  }

  /** True once, when the loud stretch reaches the hold time; the stretch then starts over. */
  push(level: number, frameMs: number): boolean {
    this.loudMs = level >= this.threshold ? this.loudMs + frameMs : 0;
    if (this.loudMs < this.holdMs) return false;
    this.loudMs = 0;
    return true;
  }

  reset(): void {
    this.loudMs = 0;
  }
}
