export function titleOf(html: string | null | undefined): string;
export function captureMismatch(
  got: { status: number; url: string; html?: string } | null | undefined,
  want: { host?: string; title?: string },
): string | null;
