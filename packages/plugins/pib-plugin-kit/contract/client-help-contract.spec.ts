/**
 * Cross-plugin contract: every sellable module has a plain-words help page, linked from its plugin page,
 * and the words are the client's, not the platform operator's (PAR-5304).
 *
 * 1. Each of the eight modules has a help page, and its route is a page route in that plugin's manifest.
 * 2. Each plugin wraps its page in `withHelp` (the banner link and the `?help=1` guide), with the module's key.
 * 3. The help text names no person and not the operator, and only uses the known placeholders.
 *
 * It reads plugin sources, so run it after changing a plugin's page or the help text.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELP_PAGES, fillHelp, helpBackTo, helpTexts, helpTo, isHelpRequested } from "../../pib-plugin-ui/src/help-content.js";

const PLUGINS_DIR = fileURLToPath(new URL("../..", import.meta.url));
const MODULES = ["crm", "mailbox", "social", "seo", "campaigns", "billing", "cockpit", "setup"] as const;

const read = (rel: string) => readFileSync(join(PLUGINS_DIR, rel), "utf8");

/** Every .ts source under a plugin folder, joined (tool names are plain string literals). */
function readTree(rel: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(PLUGINS_DIR, dir))) {
      const next = `${dir}/${name}`;
      if (statSync(join(PLUGINS_DIR, next)).isDirectory()) walk(next);
      else if (/\.tsx?$/.test(name)) out.push(read(next));
    }
  };
  walk(rel);
  return out.join("\n");
}

/** Names that must never appear in text a client reads: the operator's brand and the people who run it. */
const FORBIDDEN = [/\bpib\b/i, /partners\s*in\s*biz/i, /partnersinbiz/i, /\bpeet\b/i, /\bstander\b/i, /\belon\b/i, /\bmusk\b/i];

describe("client help pages", () => {
  it("has one page per sellable module", () => {
    expect(HELP_PAGES.map((page) => page.pluginKey).sort()).toEqual(MODULES.map((m) => `partnersinbiz.${m}`).sort());
    for (const page of HELP_PAGES) {
      expect(page.does.length).toBeGreaterThan(0);
      expect(page.agents.length).toBeGreaterThan(0);
      expect(page.owner.length).toBeGreaterThan(0);
    }
  });

  for (const page of HELP_PAGES) {
    const module = page.pluginKey.replace("partnersinbiz.", "");
    describe(page.title, () => {
      it("links to a page route the manifest declares", () => {
        const manifest = read(`plugin-${module}/src/manifest.ts`);
        const slot = new RegExp(`type:\\s*"page"[^}]*exportName:\\s*"(\\w+)"[^}]*routePath:\\s*"${page.route}"`, "s").exec(manifest);
        expect(slot, `no page slot with routePath "${page.route}" in plugin-${module}/src/manifest.ts`).not.toBeNull();
        expect(helpTo(page)).toBe(`/${page.route}?help=1`);
        expect(isHelpRequested(`?${helpTo(page).split("?")[1]}`)).toBe(true);
        expect(isHelpRequested(`?x=1`)).toBe(false);
        expect(helpBackTo(page)).toBe(`/${page.route}`);
        // The page the manifest exports is the one wrapped with the help.
        const ui = read(`plugin-${module}/src/ui/index.tsx`);
        expect(ui).toContain(`export const ${slot![1]} = withHelp(${slot![1]}Main);`);
      });

      it("wraps its page with this module's key", () => {
        expect(existsSync(join(PLUGINS_DIR, `plugin-${module}/src/ui/help-page.tsx`))).toBe(true);
        expect(read(`plugin-${module}/src/ui/help-page.tsx`)).toContain(`const PLUGIN_KEY = "${page.pluginKey}";`);
        expect(read(`plugin-${module}/package.json`)).toContain(`"name": "@partnersinbiz/plugin-${module}"`);
      });

      it("only relies on tools the plugin registers", () => {
        if (module !== "setup") expect(page.tools.length).toBeGreaterThan(0);
        const sources = readTree(`plugin-${module}/src`);
        for (const tool of page.tools) expect(sources, `plugin-${module} registers no tool "${tool}"`).toMatch(new RegExp(`["'\`]${tool}["'\`]`));
      });

      it("makes no absolute claim about approval or deletion", () => {
        for (const text of helpTexts(page)) expect(text, text).not.toMatch(/\b(nothing|never|always|every|all|without)\b.*\b(sent|deleted|erased|launch\w*|sending|changes?)\b/i);
      });

      it("names no person and not the operator", () => {
        for (const text of helpTexts(page)) {
          for (const pattern of FORBIDDEN) expect(text, `${page.title}: "${text}"`).not.toMatch(pattern);
        }
      });

      it("uses only the known placeholders and fills them all", () => {
        for (const text of helpTexts(page)) {
          const filled = fillHelp(text);
          expect(filled).not.toMatch(/\{\{|\}\}/);
          expect(fillHelp(text, { company: "Acme", owner: "Dana", ownerTitle: "founder" })).not.toMatch(/\{\{|\}\}/);
        }
      });
    });
  }

  it("keeps other query params on the help and back links", () => {
    const page = HELP_PAGES[0]!;
    expect(helpTo(page, "?client=company:1")).toBe("/crm?client=company%3A1&help=1");
    expect(helpBackTo(page, "?client=company:1&help=1")).toBe("/crm?client=company%3A1");
    expect(helpBackTo(page, "?help=1")).toBe("/crm");
  });

  it("fills placeholders from the values it is given and falls back to neutral words", () => {
    expect(fillHelp("{{company}} / {{owner}} / {{ownerTitle}}")).toBe("your company / the owner / owner");
    expect(fillHelp("{{company}} / {{owner}} / {{ownerTitle}}", { company: "Acme", owner: "Dana", ownerTitle: "founder" })).toBe("Acme / Dana / founder");
    expect(fillHelp("{{company}}", { company: "  " })).toBe("your company");
  });
});
