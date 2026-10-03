/**
 * Fixtures for the GEO checks: a small healthy site served from a table (a fetcher the test can bend, the way a firewall
 * would refuse a bot), and the pages it serves.
 */
import type { SafeFetchResult } from "@partnersinbiz/pib-plugin-kit";
import type { SiteFetcher } from "../../src/checks/site.js";

export const ORG = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": ["LocalBusiness", "ProfessionalService"],
      "@id": "https://acme.co.za/#org",
      name: "Acme Accounting",
      url: "https://acme.co.za/",
      logo: { "@type": "ImageObject", url: "https://acme.co.za/logo.png" },
      description: "Bookkeeping, VAT and payroll for small businesses in Durban, with fixed monthly fees and one named accountant.",
      telephone: "+27 31 555 0100",
      address: { "@type": "PostalAddress", streetAddress: "1 West St", addressLocality: "Durban", addressCountry: "ZA" },
      sameAs: ["https://www.linkedin.com/company/acme-accounting", "https://www.facebook.com/acmeaccounting", "https://www.hellopeter.com/acme"],
    },
    { "@type": "WebSite", name: "Acme Accounting", url: "https://acme.co.za/" },
  ],
};

export const FAQ_HTML = `<h2>What does bookkeeping cost?</h2><p>Our bookkeeping starts at R1 200 a month for a small business with up to 50 transactions, and the fee is fixed in writing before we start work.</p>
<h2>Do you do VAT returns?</h2><p>Yes. We prepare and submit your VAT201 returns on time every cycle, and we tell you in advance how much is due so there are no surprises on the day.</p>
<h2>Services</h2><p>Short.</p>`;

export function page(body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><title>Acme Accounting | Bookkeeping in Durban</title>${head}</head><body><h1>Acme Accounting</h1>${body}<p>${"Real content for the visitor. ".repeat(30)}</p></body></html>`;
}

export const GOOD_HOME = page(FAQ_HTML, `<script type="application/ld+json">${JSON.stringify(ORG)}</script>`);

export function reply(status: number, text = "", headers: Record<string, string> = {}, url = ""): SafeFetchResult {
  return { status, url, redirects: [], headers, text, ms: 1 };
}


/** A small site served from a table; `agent` lets a test refuse a bot the way a firewall would. */
export function site(overrides: Record<string, (ua: string) => SafeFetchResult | Promise<SafeFetchResult>> = {}): { fetcher: SiteFetcher; calls: string[] } {
  const calls: string[] = [];
  const routes: Record<string, (ua: string) => SafeFetchResult | Promise<SafeFetchResult>> = {
    "https://acme.co.za/robots.txt": () => reply(200, "User-agent: *\nAllow: /\nSitemap: https://acme.co.za/sitemap.xml\n"),
    "https://acme.co.za/llms.txt": () => reply(200, "# Acme Accounting\n> Books and VAT.\n## Pages\n- [Home](https://acme.co.za/)\n- [About](https://acme.co.za/about)\n- [Contact](https://acme.co.za/contact)\n"),
    "https://acme.co.za/": () => reply(200, GOOD_HOME, {}, "https://acme.co.za/"),
    "https://acme.co.za/sitemap.xml": () => reply(200, `<urlset><url><loc>https://acme.co.za/</loc></url><url><loc>https://acme.co.za/about</loc></url><url><loc>https://acme.co.za/contact</loc></url></urlset>`),
    "https://acme.co.za/about": () => reply(200, page(FAQ_HTML), {}, "https://acme.co.za/about"),
    "https://acme.co.za/contact": () => reply(200, page("<p>Call us.</p>"), {}, "https://acme.co.za/contact"),
    "https://www.linkedin.com/company/acme-accounting": () => reply(999),
    "https://www.facebook.com/acmeaccounting": () => reply(200, `<html><head><title>Acme Accounting</title></head><body>${"Page. ".repeat(80)}</body></html>`),
    "https://www.hellopeter.com/acme": () => reply(404),
    ...overrides,
  };
  const fetcher: SiteFetcher = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url} ${init?.headers?.["User-Agent"] ? `[${init.headers["User-Agent"].match(/compatible; ([^/]+)/)?.[1] ?? "ua"}]` : ""}`.trim());
    const route = routes[url];
    return route ? route(init?.headers?.["User-Agent"] ?? "") : reply(404);
  };
  return { fetcher, calls };
}

