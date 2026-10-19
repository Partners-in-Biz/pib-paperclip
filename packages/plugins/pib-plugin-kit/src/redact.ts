/**
 * Redact secrets from text: credentials, tokens, API keys, passwords.
 *
 * Copy of redactSecrets from packages/plugins/plugin-cockpit/src/watch-model.ts.
 * Keep in sync with that file.
 */

export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|apikey|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1$2[redacted]");
}
