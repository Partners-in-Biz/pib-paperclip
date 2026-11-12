// PAR-10107: page-builder and plain WordPress content shapes whose preview must not move when the insertion point
// learns to step into a pasted document's card. expected.json holds the output of buildPreviewHtml on development
// before that change (regenerate only on purpose: UPDATE_BUILDER_EXPECTED=1 npx vitest run tests/preview-builders.spec.ts).

const page = (content: string): string =>
  `<!doctype html><html><head><title>Page</title></head><body class="page"><header id="main-header"><a href="/">Site</a></header>` +
  `<div id="main-content"><article class="page type-page"><h1 class="entry-title">Theme title</h1>` +
  `<div class="entry-content">${content}</div></article></div><footer id="main-footer"><p>footer</p></footer></body></html>`;

const STYLE = `<style>.intro{color:#333}</style>`;

export const BUILDER_CASES: Record<string, string> = {
  "divi": page(`<div class="et_pb_section et_pb_section_0"><div class="et_pb_row et_pb_row_0"><div class="et_pb_module et_pb_text"><h1>Divi heading</h1><p>divi copy</p></div></div></div>`),
  "divi-style": page(`${STYLE}<div class="et_pb_section et_pb_section_0"><div class="et_pb_row et_pb_row_0"><div class="et_pb_module et_pb_text"><h1>Divi heading</h1><p>divi copy</p></div></div></div>`),
  "elementor-style": page(`${STYLE}<div data-elementor-type="wp-page" data-elementor-id="12" class="elementor elementor-12"><section class="elementor-section elementor-top-section"><div class="elementor-container"><h1>Elementor heading</h1><p>elementor copy</p></div></section></div>`),
  "wpbakery-style": page(`${STYLE}<div class="wpb-content-wrapper"><div class="vc_row wpb_row vc_row-fluid"><div class="wpb_column vc_column_container"><h1>Bakery heading</h1><p>bakery copy</p></div></div></div>`),
  "gutenberg-flex-style": page(`${STYLE}<div class="wp-block-group is-layout-flex wp-block-group-is-layout-flex"><h1 class="wp-block-heading">Group heading</h1><p>group copy</p></div>`),
  "gutenberg-columns": page(`<div class="wp-block-columns is-layout-flex"><div class="wp-block-column"><h1>Columns heading</h1><p>left</p></div><div class="wp-block-column"><p>right</p></div></div>`),
  "plain-flex-style": page(`<style>.my-wrap{display:flex;gap:12px}</style><div class="my-wrap"><h1>Wrap heading</h1><p>wrap copy</p></div>`),
  "plain-div": page(`<div class="intro"><h1>Plain heading</h1><p>plain copy</p></div>`),
  "plain-style-siblings": page(`${STYLE}<div class="intro"><h1>Intro heading</h1><p>intro copy</p></div><p>second paragraph</p>`),
  "standard": page(`<h1>Standard heading</h1><p>first</p><p>second</p><p>third</p>`),
};

export const BUILDER_MODES = ["before", "after", "replace", "h1"] as const;
