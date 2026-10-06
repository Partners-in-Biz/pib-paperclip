/**
 * The SEO progress email a client's owner gets (as a Gmail draft a person reads and sends): per site, what was done in the first four weeks,
 * what waits on them, and what happens in the next four. Built only from the sprint's own records, in plain words. Pure.
 */
export interface ProgressSite {
  siteName: string;
  siteUrl: string;
  /** Plan day the sprint is on. */
  day: number;
  /** Finished tasks of weeks 0 to 3, by week. */
  done: Array<{ week: number; titles: string[] }>;
  /** Tasks still open in weeks 0 to 3 and who they wait for. */
  open: Array<{ title: string; /** The email goes to the client, so "you" is the client and "us" is Partners in Biz. */
  waitingFor: "you" | "us" }>;
  /** Pages the client was asked about: prepared and checked, asked about, approved. */
  pages: { prepared: number; asked: number; approved: number; held: number };
  /** The plan's weeks 4 to 7. */
  next: Array<{ week: number; titles: string[] }>;
}

export interface ProgressEmailInput {
  greetingName: string | null;
  sites: ProgressSite[];
  signature: string;
}

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const weekLabel = (w: number) => (w === 0 ? "Before launch" : `Week ${w}`);

function doneLines(site: ProgressSite): string[] {
  return site.done.flatMap((w) => w.titles.map((t) => `${weekLabel(w.week)}: ${t}`));
}

function pagesLine(p: ProgressSite["pages"]): string | null {
  if (p.prepared === 0 && p.asked === 0) return null;
  const parts = [`${plural(p.prepared, "page")} written and checked by our reviewer`];
  if (p.asked > 0) parts.push(`${p.asked} waiting for your approval`);
  if (p.approved > 0) parts.push(`${p.approved} approved by you`);
  if (p.held > 0) parts.push(`${plural(p.held, "page")} put on hold because the copy did not pass our quality checks (we will come back to ${p.held === 1 ? "it" : "them"})`);
  return `${parts.join("; ")}.`;
}

export function progressSubject(sites: ProgressSite[]): string {
  return `SEO progress: ${sites.map((s) => s.siteName).join(", ")}`;
}

export function progressEmail(input: ProgressEmailInput): { subject: string; text: string; html: string } {
  const hi = input.greetingName ? `Hi ${input.greetingName}` : "Hi";
  const intro = "Here is where the SEO work stands on each of your sites, what is still open, and what happens in the next four weeks. Nothing on a website changes until the owner of that site has approved it.";
  const text: string[] = [`${hi},`, "", intro];
  const html: string[] = [`<p>${esc(hi)},</p>`, `<p>${esc(intro)}</p>`];
  for (const site of input.sites) {
    const pages = pagesLine(site.pages);
    text.push("", `== ${site.siteName} (${site.siteUrl}) ==`, "", "What has been done:");
    html.push(`<h3 style="margin:22px 0 4px">${esc(site.siteName)} <span style="font-weight:normal;color:#555;font-size:14px">${esc(site.siteUrl)}</span></h3>`, "<p><strong>What has been done</strong></p>");
    const done = doneLines(site);
    if (done.length === 0) {
      text.push("- Setup is under way.");
      html.push("<ul><li>Setup is under way.</li></ul>");
    } else {
      text.push(...done.map((d) => `- ${d}`));
      html.push(`<ul>${done.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`);
    }
    if (pages) {
      text.push("", `Pages: ${pages}`);
      html.push(`<p><strong>Pages:</strong> ${esc(pages)}</p>`);
    }
    if (site.open.length > 0) {
      text.push("", "Still open:");
      html.push("<p><strong>Still open</strong></p>");
      const lines = site.open.map((o) => `${o.title} (waiting for ${o.waitingFor})`);
      text.push(...lines.map((l) => `- ${l}`));
      html.push(`<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
    }
    text.push("", "Next four weeks:");
    html.push("<p><strong>Next four weeks</strong></p>");
    if (site.next.length === 0) {
      text.push("- To be planned with you.");
      html.push("<ul><li>To be planned with you.</li></ul>");
    } else {
      const lines = site.next.flatMap((w) => w.titles.map((t) => `${weekLabel(w.week)}: ${t}`));
      text.push(...lines.map((l) => `- ${l}`));
      html.push(`<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
    }
  }
  text.push("", "Kind regards,", input.signature);
  html.push(`<p style="margin-top:22px">Kind regards,<br>${esc(input.signature)}</p>`);
  return { subject: progressSubject(input.sites), text: text.join("\n"), html: html.join("\n") };
}
