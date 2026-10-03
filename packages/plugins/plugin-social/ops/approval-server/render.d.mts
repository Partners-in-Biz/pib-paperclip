export const TOKEN_RE: RegExp;
export function hashToken(token: string): string;
export function esc(value: unknown): string;
export const SECURITY_HEADERS: Record<string, string>;
export function messagePage(title: string, text: string, tone?: "plain" | "ok" | "err"): string;
export function approvalPage(snapshot: unknown, state?: { status?: string; answeredBy?: string | null; answeredAt?: string | null; error?: string | null; values?: { name?: string; note?: string }; action?: string }): string;
export function parseDecision(form: URLSearchParams): { ok: true; decision: "approved" | "changes_requested"; name: string; note: string | null } | { ok: false; error: string; values: { name: string; note: string } };
