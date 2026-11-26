"use strict";

function stripAnsi(text) {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

const TOOL_OUTPUT_PREFIX = "\u250a";

function stripKaomoji(text) {
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

function isAssistantToolLine(stripped) {
  return /^\u250a\s*\u{1f4ac}/u.test(stripped);
}

function extractAssistantText(line) {
  return line.replace(/^[\s\u250a]*\u{1f4ac}\s*/u, "").trim();
}

function parseToolCompletionLine(line) {
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();

  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";
  const verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;
  const detailWithoutEmoji = verbAndDetail.replace(/^\p{Emoji_Presentation}\s*/u, "");

  const hasError = /\[(?:exit \d+|error|full)\]/.test(detailWithoutEmoji) ||
    /\[error\]\s*$/.test(cleaned);

  const parts = detailWithoutEmoji.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    return { name: "tool", detail: detailWithoutEmoji, duration, hasError };
  }

  const verb = parts[1];
  const detail = parts[2].trim();
  const nameMap = {
    "$": "shell",
    exec: "shell",
    terminal: "shell",
    search: "search",
    fetch: "fetch",
    crawl: "crawl",
    navigate: "browser",
    snapshot: "browser",
    click: "browser",
    type: "browser",
    scroll: "browser",
    back: "browser",
    press: "browser",
    close: "browser",
    images: "browser",
    vision: "browser",
    read: "read",
    write: "write",
    patch: "patch",
    grep: "search",
    find: "search",
    plan: "plan",
    recall: "recall",
    proc: "process",
    delegate: "delegate",
    todo: "todo",
    memory: "memory",
    clarify: "clarify",
    session_search: "recall",
    code: "execute",
    execute: "execute",
    web_search: "search",
    web_extract: "fetch",
    browser_navigate: "browser",
    browser_click: "browser",
    browser_type: "browser",
    browser_snapshot: "browser",
    browser_vision: "browser",
    browser_scroll: "browser",
    browser_press: "browser",
    browser_back: "browser",
    browser_close: "browser",
    browser_get_images: "browser",
    read_file: "read",
    write_file: "write_file",
    search_files: "search",
    patch_file: "patch",
    execute_code: "execute",
  };

  return {
    name: nameMap[verb.toLowerCase()] || verb,
    detail,
    duration,
    hasError,
  };
}

let toolCallCounter = 0;

function syntheticToolUseId() {
  toolCallCounter += 1;
  return `hermes-tool-${toolCallCounter}`;
}

function isThinkingLine(line) {
  return (
    line.includes("\u{1f4ad}") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

function parseStdoutLine(line, ts) {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.type === "string") {
        const type = parsed.type;
        if (type === "text") {
          const text = typeof parsed.text === "string" ? parsed.text : "";
          return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
        }
        if (type === "system") {
          if (parsed.subtype === "init" && typeof parsed.session_id === "string" && parsed.session_id.trim()) {
            return [{ kind: "system", ts, text: `[hermes] Session checkpoint: ${parsed.session_id.trim()}` }];
          }
          return [];
        }
        if (type === "thinking" || type === "reasoning") {
          const text =
            typeof parsed.text === "string"
              ? parsed.text
              : typeof parsed.thinking === "string"
                ? parsed.thinking
                : "";
          return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
        }
        if (type === "tool_use" && typeof parsed.name === "string") {
          const id =
            typeof parsed.tool_call_id === "string" && parsed.tool_call_id
              ? parsed.tool_call_id
              : typeof parsed.id === "string" && parsed.id
                ? parsed.id
                : syntheticToolUseId();
          return [
            {
              kind: "tool_call",
              ts,
              name: parsed.name,
              input: parsed.input ?? {},
              toolUseId: id,
            },
          ];
        }
        if (type === "tool_result") {
          const id =
            typeof parsed.tool_call_id === "string" && parsed.tool_call_id
              ? parsed.tool_call_id
              : typeof parsed.tool_use_id === "string" && parsed.tool_use_id
                ? parsed.tool_use_id
                : syntheticToolUseId();
          const content =
            typeof parsed.content === "string"
              ? parsed.content
              : typeof parsed.output === "string"
                ? parsed.output
                : typeof parsed.text === "string"
                  ? parsed.text
                  : typeof parsed.error === "string"
                    ? parsed.error
                    : "";
          return [
            {
              kind: "tool_result",
              ts,
              toolUseId: id,
              content,
              isError: parsed.is_error === true,
            },
          ];
        }
        if (type === "result") {
          if (typeof parsed.error === "string" && parsed.error.trim()) {
            return [{ kind: "stderr", ts, text: parsed.error.trim() }];
          }
          const exit = typeof parsed.exit_code === "number" ? ` exit=${parsed.exit_code}` : "";
          return [{ kind: "system", ts, text: `[hermes] stream result${exit}` }];
        }
        if (type === "error" && typeof parsed.error === "string") {
          return [{ kind: "stderr", ts, text: parsed.error }];
        }
      }
    } catch {
      // Not valid JSON — fall through to normal line handling.
    }
  }

  if (trimmed.startsWith("[tool]")) {
    return [];
  }

  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
    return [];
  }

  if (trimmed.startsWith("session_id:")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
    if (isAssistantToolLine(trimmed)) {
      return [{ kind: "assistant", ts, text: extractAssistantText(trimmed) }];
    }

    const toolInfo = parseToolCompletionLine(trimmed);
    if (toolInfo) {
      const id = syntheticToolUseId();
      const detailText = toolInfo.duration
        ? `${toolInfo.detail}  ${toolInfo.duration}`
        : toolInfo.detail;

      return [
        {
          kind: "tool_call",
          ts,
          name: toolInfo.name,
          input: { detail: toolInfo.detail },
          toolUseId: id,
        },
        {
          kind: "tool_result",
          ts,
          toolUseId: id,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ];
    }

    const escapedPrefix = TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = trimmed
      .replace(/^\[done\]\s*/, "")
      .replace(new RegExp(`^${escapedPrefix}\\s*`), "")
      .trim();
    return [{ kind: "stdout", ts, text: stripped }];
  }

  if (isThinkingLine(trimmed)) {
    return [{ kind: "thinking", ts, text: trimmed.replace(/^\u{1f4ad}\s*/u, "") }];
  }

  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  return [{ kind: "assistant", ts, text: trimmed }];
}

module.exports = { parseStdoutLine };
