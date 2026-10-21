/**
 * Cross-plugin contract: the Social skill `pib-creative-studio` (W5).
 *
 * Every tool-like name the skill (or the media-studio reference) backticks is registered by some plugin manifest, so the skill
 * never sends an agent to a tool that does not exist.
 */
import { describe, expect, it } from "vitest";

type Manifest = { id: string; tools?: Array<{ name: string }> };

const PLUGINS = ["cockpit", "crm", "mailbox", "social", "seo", "campaigns", "billing", "accounting", "payroll", "partners", "setup"] as const;

describe("creative studio skill contract", async () => {
  const manifests: Manifest[] = [];
  for (const p of PLUGINS) manifests.push((await import(`../../plugin-${p}/src/manifest.ts`)).default as Manifest);
  const registered = new Set(manifests.flatMap((m) => (m.tools ?? []).map((t) => t.name)));
  const { SKILLS } = await import("../../plugin-social/src/skills.ts");
  const texts = [
    ["pib-creative-studio", SKILLS.find((s: { skillKey: string }) => s.skillKey === "creative-studio")!.markdown],
    ["media-studio.md", SKILLS.find((s: { skillKey: string }) => s.skillKey === "social-content")!.files!.find((f: { path: string }) => f.path === "references/media-studio.md")!.content],
  ] as const;

  it.each(texts)("every tool %s names is registered", (_name, text) => {
    const named = [...text.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!);
    const tools = named.filter((n) => n !== "media-rule" && /^(get|list|create|update|import|request|record|validate|media|attach|schedule)-/.test(n));
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((n) => !registered.has(n)), "named but not registered by any plugin").toEqual([]);
  });
});
