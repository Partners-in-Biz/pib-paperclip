import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModuleHelp, PageFrame } from "@partnersinbiz/pib-plugin-ui";

const linkProps = (to: string) => ({ href: `/ACME${to}` });

const render = (search: string, pluginKey = "partnersinbiz.cockpit") =>
  renderToStaticMarkup(createElement(ModuleHelp, { pluginKey, search, linkProps, children: createElement(PageFrame, null, createElement("p", null, "page body")) }));

describe("module help wrapper", () => {
  it("adds the guide link to the page banner", () => {
    const html = render("");
    expect(html).toContain("page body");
    expect(html).toContain("New to Cockpit?");
    expect(html).toContain('href="/ACME/cockpit?help=1"');
  });

  it("shows the guide instead of the page at ?help=1, with a way back", () => {
    const html = render("?help=1");
    expect(html).not.toContain("page body");
    expect(html).toContain("How Cockpit works");
    expect(html).toContain("What the agents do");
    expect(html).toContain('href="/ACME/cockpit"');
    expect(html).not.toMatch(/\{\{/);
    expect(html).toContain("your company");
  });

  it("leaves a page alone when the module has no guide", () => {
    const html = render("?help=1", "partnersinbiz.unknown");
    expect(html).toContain("page body");
    expect(html).not.toContain("plain-words");
  });
});
