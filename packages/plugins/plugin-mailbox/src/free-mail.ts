/** Mail services used by everybody: a sender on one of these says nothing about which company it is. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "mweb.co.za",
  "telkomsa.net",
  "vodamail.co.za",
  "webmail.co.za",
  "absamail.co.za",
  "lantic.net",
  "iafrica.com",
]);

export function isFreeMailDomain(domain: string | null): boolean {
  return !domain || FREE_MAIL.has(domain.toLowerCase());
}
