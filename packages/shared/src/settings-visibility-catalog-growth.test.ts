import { afterEach, expect, it, vi } from "vitest";

// This package runs with isolate:false, so workers share modules between test files: the real catalog may already
// be loaded, and a mocked one would reach the next file. Mock and import inside the test, then undo both.
afterEach(() => {
  vi.doUnmock("./feature-catalog.js");
  vi.resetModules();
});

it("hides an added catalog feature without an operator configuration change", async () => {
  vi.resetModules();
  // Model a future Core release without changing the operator's policy.
  vi.doMock("./feature-catalog.js", async (importOriginal) => {
    const catalog = await importOriginal<typeof import("./feature-catalog.js")>();
    return { ...catalog, INSTANCE_FEATURE_KEYS: [...catalog.INSTANCE_FEATURE_KEYS, "enableFutureFeature"] };
  });
  const { parseHiddenSettingsList } = await import("./settings-visibility.js");

  const parsed = parseHiddenSettingsList("instance.plugins,instance.experimental.*,!instance.experimental.enableEnvironments");
  expect(parsed.unknown).toEqual([]);
  expect(parsed.hidden).toContain("instance.experimental.enableFutureFeature");
  expect(parsed.hidden).toContain("instance.plugins");
  expect(parsed.hidden).not.toContain("instance.experimental.enableEnvironments");
});
