import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: false,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
