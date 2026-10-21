'use strict';
const { EXIT } = require('./exit-codes.cjs');

function checkFill({ field, pageUrl, site, handoffActive }) {
  // Hand-off mode lifts all restrictions
  if (handoffActive === true) {
    return { ok: true };
  }

  // a. field missing/not an object => fail closed
  if (!field || typeof field !== 'object') {
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'field_unknown' };
  }

  // b. field.type === 'password'
  if (String(field.type).toLowerCase() === 'password') {
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'password_field_refused' };
  }

  // c. field.autocomplete contains substring 'password'
  if (String(field.autocomplete).toLowerCase().includes('password')) {
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'password_field_refused' };
  }

  // d. pageUrl on logged-in page
  if (!site?.loggedIn?.url) {
    // Missing site.loggedIn.url => treat as logged-in page, refuse
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fill_on_logged_in_page' };
  }

  try {
    const pageURLObj = new URL(pageUrl);

    // Try to parse site.loggedIn.url as absolute URL
    let isLoggedInPage = false;
    try {
      const siteURLObj = new URL(site.loggedIn.url);
      // Both are absolute URLs: check origin + pathname prefix
      if (pageURLObj.origin === siteURLObj.origin) {
        const pagePathname = pageURLObj.pathname.replace(/\/$/, '');
        const sitePathname = siteURLObj.pathname.replace(/\/$/, '');
        if (pagePathname.startsWith(sitePathname)) {
          isLoggedInPage = true;
        }
      }
    } catch (e) {
      // site.loggedIn.url is relative (or invalid): check pathname prefix only
      const pagePathname = pageURLObj.pathname.replace(/\/$/, '');
      const sitePathname = site.loggedIn.url.replace(/\/$/, '');
      if (pagePathname.startsWith(sitePathname)) {
        isLoggedInPage = true;
      }
    }

    if (isLoggedInPage) {
      return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fill_on_logged_in_page' };
    }
  } catch (e) {
    // pageUrl is unparsable => treat as logged-in page, refuse
    return { exit: EXIT.REFUSED_BY_POLICY, ok: false, reason: 'fill_on_logged_in_page' };
  }

  return { ok: true };
}

module.exports = { checkFill };
