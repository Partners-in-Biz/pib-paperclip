export const REDACTED_COMMAND_TEXT_VALUE = "***REDACTED***";

// These exact public Executor helper addresses resemble dotted bearer tokens.
// Do not exempt arbitrary provider paths, prefixes, or user-defined selectors.
const PUBLIC_EXECUTOR_TOOL_SELECTORS = new Set([
  "executor.coreTools.integrations.list",
  "executor.coreTools.connections.list",
  "executor.coreTools.policies.list",
]);
export function isPublicExecutorToolSelector(value: string): boolean {
  return PUBLIC_EXECUTOR_TOOL_SELECTORS.has(value);
}

// A secret name is an identifier run containing one of these words. The old
// pattern `[A-Za-z0-9_-]*(?:word)[A-Za-z0-9_-]*` followed by a required
// character backtracks quadratically on long identifier runs such as
// base64url attachment bodies, which froze the Paperclip server (PAR-8028).
// Match the run without backtracking, then test it for a word in code.
const SECRET_NAME_WORD_RE =
  /(?:api[-_]?key|(?:access[-_]?|auth[-_]?)?token|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
// Whole run from its start; `(?=(...))\k<...>` is an atomic group, so a failed
// match never retries shorter prefixes. Group: name.
const RUN_START_NAME = String.raw`(?<![A-Za-z0-9_-])(?=(?<name>[A-Za-z0-9_-]+))\k<name>`;
// A quoted JSON key: the whole run up to the closing quote. Group: name.
const QUOTED_NAME = String.raw`(?=(?<name>[A-Za-z0-9_-]+))\k<name>`;
// CLI flags keep the old `\B-` start, which can sit inside a run (`a--b`), so
// cap the name: each start then costs at most 256 steps. Group: flag.
const BOUNDED_NAME_RUN = String.raw`(?=(?<flag>[A-Za-z0-9_-]{1,256}))\k<flag>(?![A-Za-z0-9_-])`;

function replaceSecretNamed(
  input: string,
  re: RegExp,
  replace: (match: RegExpExecArray) => string,
): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(input)) !== null) {
    const name = match[2];
    if (!SECRET_NAME_WORD_RE.test(name)) {
      // Resume after the name, not the value, so a secret assignment inside
      // this value is still found, as with the old backtracking pattern.
      re.lastIndex = match.index + match[0].indexOf(name) + name.length;
      continue;
    }
    parts.push(input.slice(copiedThrough, match.index), replace(match));
    copiedThrough = match.index + match[0].length;
  }
  if (copiedThrough === 0) return input;
  parts.push(input.slice(copiedThrough));
  return parts.join("");
}

const COMMAND_CLI_SECRET_OPTION_RE = new RegExp(
  String.raw`(\B-{1,2}${BOUNDED_NAME_RUN}(?:\s+|=)(["']?))[^\s"'` +
    "`" +
    String.raw`]+(\3)`,
  "g",
);
const COMMAND_ENV_SECRET_ASSIGNMENT_RE = new RegExp(
  String.raw`(${RUN_START_NAME}\s*=\s*)(?:(\\["'])([\s\S]*?)\3|(["'])([^"'` +
    "`" +
    String.raw`\r\n]*)\5|([^\s"'` +
    "`" +
    String.raw`]+))`,
  "g",
);
const COMMAND_AUTHORIZATION_BEARER_RE =
  /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const COMMAND_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const COMMAND_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const COMMAND_JWT_RE =
  // Start only at the first word character of an identifier run (the leftmost
  // `\b` the old pattern could use). A bare `\b` also started after every `-`
  // inside a run and rescanned it each time: quadratic on base64url (PAR-8028).
  /(?<=(?:^|[^A-Za-z0-9_-])-*)\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const COMMAND_SECRET_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;

function maybeContainsSecretText(command: string) {
  const lower = command.toLowerCase();
  return (
    COMMAND_SECRET_HINTS.some((hint) => lower.includes(hint)) ||
    command.includes(".")
  );
}

export function redactCommandText(
  command: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  if (!maybeContainsSecretText(command)) return command;
  const withoutCliSecrets = replaceSecretNamed(
    command.replace(COMMAND_AUTHORIZATION_BEARER_RE, `$1${redactedValue}`),
    COMMAND_CLI_SECRET_OPTION_RE,
    (match) => `${match[1]}${redactedValue}${match[4]}`,
  );
  return replaceSecretNamed(
    withoutCliSecrets,
    COMMAND_ENV_SECRET_ASSIGNMENT_RE,
    (match) => {
      const prefix = match[1];
      const quote = match[3] ?? match[5];
      return quote
        ? `${prefix}${quote}${redactedValue}${quote}`
        : `${prefix}${redactedValue}`;
    },
  )
    .replace(COMMAND_OPENAI_KEY_RE, redactedValue)
    .replace(COMMAND_GITHUB_TOKEN_RE, redactedValue)
    .replace(COMMAND_JWT_RE, (match, offset: number, source: string) => {
      // The JWT heuristic may match only the first three segments; inspect the
      // complete address so a longer secret sharing a prefix stays redacted.
      const address = source.slice(offset).match(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/)?.[0];
      return address && isPublicExecutorToolSelector(address) ? match : redactedValue;
    });
}

// A JSON secret field is a key/value pair such as `"token":"opaque-value"`. The
// command redaction handles shell `KEY=value` syntax only. A sandbox diagnostic
// can also carry a serialized JSON error, so the sanitizer must redact the JSON
// form too. The value body consumes JSON escape sequences. An escaped quote
// (`\"`) inside the value does not end the match early.
const JSON_SECRET_FIELD_RE = new RegExp(
  String.raw`("${QUOTED_NAME}"\s*:\s*")(?:\\[\s\S]|[^"\\])*(")`,
  "g",
);
// An escaped JSON secret field is the same pair inside a JSON string. The double
// quote appears as `\"` and a backslash appears as `\\`. The value body
// consumes the doubled escape sequences. An escaped quote inside the value does
// not end the match early. The value ends at the next unescaped `\"`.
const JSON_ESCAPED_SECRET_FIELD_RE = new RegExp(
  String.raw`(\\"${QUOTED_NAME}\\"\s*:\s*\\")(?:\\\\\\\\|\\\\\\"|\\\\[\s\S]|[^\\"])*(\\")`,
  "g",
);

/**
 * Redact secrets from an untrusted diagnostic string.
 *
 * The function first runs the command redaction. The command redaction handles
 * shell `KEY=value` assignments, CLI secret options, bearer headers, and common
 * token shapes. The function then redacts JSON and escaped-JSON secret fields,
 * because a sandbox diagnostic can carry a serialized JSON error such as
 * `{"token":"opaque-value"}`. The caller must still bound the length after this
 * step.
 */
export function redactDiagnosticText(
  text: string,
  redactedValue = REDACTED_COMMAND_TEXT_VALUE,
): string {
  // Groups: 1 = prefix, 2 = name, 3 = closing quote.
  const replace = (match: RegExpExecArray) => `${match[1]}${redactedValue}${match[3]}`;
  return replaceSecretNamed(
    replaceSecretNamed(
      redactCommandText(text, redactedValue),
      JSON_ESCAPED_SECRET_FIELD_RE,
      replace,
    ),
    JSON_SECRET_FIELD_RE,
    replace,
  );
}
