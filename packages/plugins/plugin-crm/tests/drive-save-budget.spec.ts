import { describe, expect, it } from "vitest";
import { DRIVE_TOOLS } from "../src/drive/tools.js";

describe("Drive tools gateway budget (PAR-10249)", () => {
  it.each(["drive_file_save", "drive_folder_ensure", "drive_files_list"])("%s declares 25 s", (name) => {
    expect(DRIVE_TOOLS.find((t) => t.name === name)?.timeoutMs).toBe(25_000);
  });
});
