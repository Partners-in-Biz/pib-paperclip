/**
 * The approval email a sprint's client gets (as a Gmail draft a person reads and sends): the pages we propose to change, one
 * link each, and how the answer works. Pure. Nothing here promises more than the preview does: a link shows the page with the
 * proposed changes, an Approve and a Request-changes button, and nothing on the client's site changes until the client approves.
 */
export interface ApprovalPage {
  title: string;
  pageUrl: string;
  link: string;
}

export interface ApprovalEmailInput {
  siteName: string;
  /** The client's own people we write to (first names, for the greeting). */
  firstNames: string[];
  pages: ApprovalPage[];
  /** The preview links stay open this many days. */
  openDays: number;
  /** Who signs (the company's name). */
  signature: string;
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function approvalSubject(siteName: string, pages: number): string {
  return `${pages === 1 ? "Please review a proposed change" : `Please review ${pages} proposed changes`} for ${siteName}`;
}

function greeting(firstNames: string[]): string {
  const names = [...new Set(firstNames.map((n) => n.trim()).filter(Boolean))].slice(0, 3);
  if (names.length === 0) return "Hi";
  if (names.length === 1) return `Hi ${names[0]}`;
  return `Hi ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function approvalEmail(input: ApprovalEmailInput): { subject: string; text: string; html: string } {
  const n = input.pages.length;
  const open = `${n === 1 ? "the page" : `each of the ${n} pages`}`;
  const intro = `We have prepared ${n === 1 ? "a proposed change" : `proposed changes`} for ${input.siteName}. Nothing on your website changes until you approve it.`;
  const how = `Open ${open} below. You will see your page with the proposed changes on it. Press Approve if you are happy, or Request changes and tell us what to adjust. We only publish what you approve. The links stay open for ${input.openDays} days.`;
  const lines = input.pages.map((p, i) => `${i + 1}. ${p.title}\n   ${p.pageUrl}\n   ${p.link}`);
  const text = [`${greeting(input.firstNames)},`, "", intro, "", how, "", ...lines, "", "Kind regards,", input.signature].join("\n");
  const items = input.pages
    .map((p) => `<li style="margin:0 0 12px"><strong>${esc(p.title)}</strong><br><span style="color:#555">${esc(p.pageUrl)}</span><br><a href="${esc(p.link)}">View and approve</a></li>`)
    .join("");
  const html = [
    `<p>${esc(greeting(input.firstNames))},</p>`,
    `<p>${esc(intro)}</p>`,
    `<p>${esc(how)}</p>`,
    `<ol style="padding-left:20px">${items}</ol>`,
    `<p>Kind regards,<br>${esc(input.signature)}</p>`,
  ].join("\n");
  return { subject: approvalSubject(input.siteName, n), text, html };
}

/** The addresses to draft to: the client's people on the client's own domain; if none, each person's first address. At most 3. */
export function approverAddresses(contacts: Array<{ name: string; emails: string[] }>, siteHost: string): Array<{ email: string; name: string }> {
  const host = siteHost.replace(/^www\./, "").toLowerCase();
  const out: Array<{ email: string; name: string }> = [];
  const add = (email: string, name: string) => {
    const clean = email.trim().toLowerCase();
    if (clean && !out.some((o) => o.email === clean)) out.push({ email: clean, name });
  };
  for (const c of contacts) for (const e of c.emails) if (e.toLowerCase().endsWith(`@${host}`)) add(e, c.name);
  if (out.length === 0) for (const c of contacts) if (c.emails[0]) add(c.emails[0], c.name);
  return out.slice(0, 3);
}
