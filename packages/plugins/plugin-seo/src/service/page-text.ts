/**
 * Normalize visible text from HTML pages for client fact verification.
 * Strips hidden elements, tags, decodes entities, normalizes whitespace and punctuation.
 */

/**
 * Decode HTML entities to characters (e.g. &amp; -> &, &#8217; -> ').
 * Simple regex-based decoding that handles common entities and numeric codes.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&(?:#\d+|#x[0-9a-fA-F]+|[a-z]+);/gi, (match) => {
      const entityMap: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&nbsp;": " ",
        "&#160;": " ",
        "&ldquo;": '"',
        "&rdquo;": '"',
        "&lsquo;": "'",
        "&rsquo;": "'",
        "&ndash;": "-",
        "&mdash;": "-",
      };
      if (match in entityMap) return entityMap[match as keyof typeof entityMap];

      // Numeric entities
      if (match.startsWith("&#x")) {
        return String.fromCharCode(parseInt(match.slice(3, -1), 16));
      }
      if (match.startsWith("&#")) {
        return String.fromCharCode(parseInt(match.slice(2, -1), 10));
      }
      return match;
    });
}

/**
 * Remove HTML tags and hidden content, returning only visible text.
 * Handles: head section, comments, svg, hidden, aria-hidden="true", inline display:none, script, style, noscript, template.
 */
export function normalizeVisibleText(html: string): string {
  let result = "";
  let i = 0;
  const hiddenStack: string[] = []; // Track tag names to match closing tags
  let isHidden = false;

  while (i < html.length) {
    // Check for HTML comment
    if (html.startsWith("<!--", i)) {
      const commentEnd = html.indexOf("-->", i + 4);
      if (commentEnd !== -1) {
        i = commentEnd + 3;
      } else {
        // Unterminated comment: skip to end
        i = html.length;
      }
      continue;
    }

    // Check for tag start
    if (html[i] === "<") {
      const endTag = html.indexOf(">", i);
      if (endTag === -1) {
        i++;
        continue;
      }

      const tagContent = html.slice(i + 1, endTag);
      const tagLower = tagContent.toLowerCase();

      // Remove the tag itself
      i = endTag + 1;

      // Head section: remove entire <head>...</head>
      if (/^head\b/i.test(tagContent)) {
        const closingHeadIndex = html.toLowerCase().indexOf("</head>", i);
        if (closingHeadIndex !== -1) {
          i = closingHeadIndex + 7; // "</head>".length
        }
        continue;
      }

      // SVG section: remove entire <svg>...</svg>
      if (/^svg\b/i.test(tagContent)) {
        const closingSvgIndex = html.toLowerCase().indexOf("</svg>", i);
        if (closingSvgIndex !== -1) {
          i = closingSvgIndex + 6; // "</svg>".length
        }
        continue;
      }

      // Script, style, noscript, template: remove entire section
      if (/^(script|style|noscript|template)\b/i.test(tagContent)) {
        const tagName = tagLower.split(/\s/)[0];
        const closingTag = `</${tagName}>`;
        const closingIndex = html.toLowerCase().indexOf(closingTag, i);
        if (closingIndex !== -1) {
          i = closingIndex + closingTag.length;
        }
        continue;
      }

      // Detect closing tags to pop hidden stack
      if (tagLower.startsWith("/")) {
        const closingTagName = tagLower.slice(1).split(/\s/)[0];
        // Pop from stack if the last hidden entry matches this tag
        if (hiddenStack.length > 0 && hiddenStack[hiddenStack.length - 1] === closingTagName) {
          hiddenStack.pop();
          isHidden = hiddenStack.length > 0;
        }
        // Replace block-level closing tags with a space for word boundaries
        if (/^\/(p|div|h[1-6]|li|tr)\b/i.test(tagContent)) {
          if (!isHidden) result += " ";
        }
        continue;
      }

      // Check if this is a self-closing/void element (br, hr, img, input, etc.)
      const isVoidElement = /\b(br|hr|img|input|meta|link|source|track|embed|param)\b/i.test(tagContent);
      const tagName = tagLower.split(/\s/)[0];

      // Handle hidden attribute or aria-hidden="true" for opening tags
      if (/\bhidden\b|\baria-hidden\s*=\s*["']?true["']?/i.test(tagContent)) {
        // Only push to stack if this is NOT a void element
        // Void elements don't have children so they shouldn't affect visibility of following content
        if (!isVoidElement) {
          hiddenStack.push(tagName);
          isHidden = true;
        }
        // For void elements, just skip them but don't change isHidden state
        continue;
      }

      // Handle inline display:none for opening tags
      if (/\bstyle\s*=\s*["'][^"']*display\s*:\s*none/i.test(tagContent)) {
        // Only push to stack if this is NOT a void element
        if (!isVoidElement) {
          hiddenStack.push(tagName);
          isHidden = true;
        }
        // For void elements, just skip them but don't change isHidden state
        continue;
      }

      continue;
    }

    // Text content (not in a tag)
    if (!isHidden) {
      result += html[i];
    }
    i++;
  }

  // Decode entities
  const decoded = decodeEntities(result);

  // Normalize: NFC, fold curly quotes to straight, fold dashes to hyphen, collapse whitespace
  const nfc = decoded.normalize("NFC");
  const folded = nfc
    .replace(/[‘’]/g, "'") // curly single quotes -> apostrophe
    .replace(/[“”]/g, '"') // curly double quotes -> straight quotes
    .replace(/[–—]/g, "-") // endash, emdash -> hyphen
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  // Collapse whitespace (including &nbsp; which became space)
  const collapsed = folded.replace(/\s+/g, " ").trim();

  return collapsed;
}

/**
 * Normalize a wording for comparison with page text.
 * Applies: NFC, entity decode, fold quotes/dashes, collapse whitespace.
 */
export function normalizeWording(text: string): string {
  const decoded = decodeEntities(text);
  const nfc = decoded.normalize("NFC");
  const folded = nfc
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-");

  const collapsed = folded.replace(/\s+/g, " ").trim();
  return collapsed;
}

/**
 * Check if a normalized wording appears in normalized page text as a substring
 * with proper word boundaries (alphanumeric before/after must not match).
 */
export function wordingAppearsInText(normalizedWording: string, normalizedPageText: string): boolean {
  if (normalizedWording.length === 0) return false;
  if (normalizedWording.length > normalizedPageText.length) return false;

  let pos = 0;
  while ((pos = normalizedPageText.indexOf(normalizedWording, pos)) !== -1) {
    // Check character before
    const charBefore = pos > 0 ? normalizedPageText[pos - 1] : " ";
    const isAlphanumericBefore = /[\p{L}\p{N}]/u.test(charBefore);

    // Check character after
    const endPos = pos + normalizedWording.length;
    const charAfter = endPos < normalizedPageText.length ? normalizedPageText[endPos] : " ";
    const isAlphanumericAfter = /[\p{L}\p{N}]/u.test(charAfter);

    // Both boundary checks must pass (not alphanumeric)
    if (!isAlphanumericBefore && !isAlphanumericAfter) {
      return true;
    }

    pos++;
  }

  return false;
}
