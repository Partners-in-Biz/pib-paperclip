/** One sentence about applying an approved preview of a category, tag or other archive page (PAR-8972 T4). Shared by the agent's wake comments and the skill text. */
export const LIVE_CHECK_GUIDANCE =
  "Before applying an approved preview run list-previews previewId=<id> checkLive=true. changed: do not apply, make a fresh preview. unknown: compare the live page with the preview html (includeHtml) where the change goes; any difference: fresh preview.";

export const ARCHIVE_APPLY_GUIDANCE =
  "Category, tag or other archive page: title and meta with wp-seo (url = the page); H1 and intro with wp-archive set (html = <h1>h1</h1> + bodyHtml, position = bodyMode before or after); never wp-content update. bodyMode replace on an archive cannot be applied: make a fresh preview with before or after. bodyMode afterFirstParagraph on an archive cannot be applied either: it needs a fresh before/after preview.";

export const LINK_EDITS_APPLY_GUIDANCE =
  "linkEdits: read post_content (wp-content get); the phrase must occur exactly once; replace that one occurrence with `<a href=\"HREF\">phrase</a>` via wp-content update. Zero or several occurrences: do not apply; make a fresh preview with a longer phrase.";

export const AFTER_FIRST_PARAGRAPH_APPLY_GUIDANCE =
  "bodyMode afterFirstParagraph: read post_content (wp-content get) and find the first words of the intro paragraph quoted in the preview notes; insert the approved markup right after that paragraph's closing </p>, via wp-content update. If the quoted first words are not in the raw wp-content get output, stop and make a fresh before/after preview; do not guess a spot. Put the inserted markup in as one line with no blank lines (wpautop turns blank lines into paragraphs).";

/** True when a stored preview's changes (object or JSON string) use bodyMode afterFirstParagraph with a body. */
export function usesAfterFirstParagraph(changes: unknown): boolean {
  try {
    const c = (typeof changes === "string" ? JSON.parse(changes) : changes) as { bodyMode?: unknown; bodyHtml?: unknown } | null;
    return c?.bodyMode === "afterFirstParagraph" && Boolean(c.bodyHtml);
  } catch {
    return false;
  }
}
