import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The host loads plugin UI from blob: URLs, so a relative chunk import cannot resolve (PAR-14660).
describe("cockpit UI bundle", () => {
  it("has no relative imports in dist/ui/*.js", () => {
    execFileSync("node", ["./esbuild.config.mjs"], { cwd: root, stdio: "pipe" });
    const dir = join(root, "dist", "ui");
    const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from\s*["']\.\.?\//);
      expect(text, file).not.toMatch(/import\(\s*["']\.\.?\//);
    }
  });
});
