'use strict';
const EXIT = Object.freeze({
  DONE: 0, USAGE: 2, NO_BROWSER: 3, EXPECT_MISSING: 4,
  NO_SCREENSHOT: 5, SESSION_EXPIRED: 6, REFUSED_BY_POLICY: 7, NEEDS_APPROVAL: 8
});
const map = { 0: 'done', 2: 'usage', 3: 'no_browser', 4: 'expect_missing',
  5: 'no_screenshot', 6: 'session_expired', 7: 'refused_by_policy', 8: 'needs_approval' };
module.exports = { EXIT, exitName: (c) => map[c] };
