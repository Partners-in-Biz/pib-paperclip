/** A refusal or failure whose message is safe to show to a person or an agent. */
export class StudioError extends Error {
  constructor(message: string, readonly code: string = "studio_error") {
    super(message);
    this.name = "StudioError";
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
