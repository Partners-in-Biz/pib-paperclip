/**
 * Voice-note recording. Phones record in their own container (iPhone: mp4/AAC,
 * Android Chrome: webm/Opus); xAI's transcriber accepts both, so nothing is
 * re-encoded in the browser.
 */

/** Order matters: mp4 first because iOS Safari supports only that. */
export const RECORDING_TYPES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

/** Hard stop so a forgotten recording cannot grow past the upload cap. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;

/** Stop a little under the server's 7 MiB upload cap. */
export const MAX_RECORDING_BYTES = 6.5 * 1024 * 1024;

/** Speech needs little: 48 kbps keeps ten minutes near 3.6 MB, well under the 7 MB upload cap. */
export const RECORDING_BITS_PER_SECOND = 48_000;

export function pickRecordingType(isSupported: (type: string) => boolean): string | null {
  for (const type of RECORDING_TYPES) {
    if (isSupported(type)) return type;
  }
  return null;
}

export function voiceSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext
  );
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface ActiveRecording {
  stop(): Promise<RecordingResult>;
  cancel(): void;
  startedAt: number;
}

export async function startRecording(onAutoStop?: () => void): Promise<ActiveRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const releaseStream = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  const type = pickRecordingType((t) => MediaRecorder.isTypeSupported(t));
  const options: MediaRecorderOptions = { audioBitsPerSecond: RECORDING_BITS_PER_SECOND };
  if (type) options.mimeType = type;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch (err) {
    releaseStream();
    throw err;
  }
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let settled = false;

  let bytes = 0;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
      bytes += event.data.size;
      // Stop before the server's upload cap, whatever bitrate the browser picked.
      if (bytes >= MAX_RECORDING_BYTES) onAutoStop?.();
    }
  });

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const timer = window.setTimeout(() => onAutoStop?.(), MAX_RECORDING_MS);
  // A timeslice keeps data flowing on Safari, which can otherwise drop a long single chunk.
  try {
    recorder.start(1000);
  } catch (err) {
    window.clearTimeout(timer);
    releaseStream();
    throw err;
  }

  return {
    startedAt,
    stop() {
      return new Promise<RecordingResult>((resolve, reject) => {
        if (settled) {
          reject(new Error("Recording already finished."));
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        recorder.addEventListener(
          "stop",
          () => {
            release();
            const mimeType = recorder.mimeType || type || "audio/mp4";
            resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationMs: Date.now() - startedAt });
          },
          { once: true },
        );
        recorder.addEventListener("error", () => {
          release();
          reject(new Error("The recording failed."));
        }, { once: true });
        recorder.stop();
      });
    },
    cancel() {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
      release();
    },
  };
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.readAsDataURL(blob);
  });
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
