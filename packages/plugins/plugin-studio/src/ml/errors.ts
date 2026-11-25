/** The runner's named exit codes (PAR-10126 D5b); on failure stdout holds `{"ok":false,"code":"<name>","error":"..."}`. */
export const EXIT = { ok: 0, usage: 2, runtime_missing: 3, model_missing: 4, model_bad: 5, bad_input: 6, decode_failed: 7, bad_engine: 8, encode_failed: 9 } as const;
export type ExitName = keyof typeof EXIT;

export class RunnerError extends Error {
  constructor(readonly code: ExitName, message: string) {
    super(message);
  }
}
