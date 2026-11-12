/** One sentence about applying an approved preview of a category, tag or other archive page (PAR-8972 T4). Shared by the agent's wake comments and the skill text. */
export const LIVE_CHECK_GUIDANCE =
  "Before applying an approved preview run list-previews previewId=<id> checkLive=true. changed: do not apply, make a fresh preview. unknown: compare the live page with the preview html (includeHtml) where the change goes; any difference: fresh preview.";

export const ARCHIVE_APPLY_GUIDANCE =
  "Category, tag or other archive page: title and meta with wp-seo (url = the page); H1 and intro with wp-archive set (html = <h1>h1</h1> + bodyHtml, position = bodyMode before or after); never wp-content update. bodyMode replace on an archive cannot be applied: make a fresh preview with before or after.";

export const LINK_EDITS_APPLY_GUIDANCE =
  "linkEdits: read post_content (wp-content get); the phrase must occur exactly once; replace that one occurrence with `<a href=\"HREF\">phrase</a>` via wp-content update. Zero or several occurrences: do not apply; make a fresh preview with a longer phrase.";
