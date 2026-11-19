import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills/paperclip");

/** Reference files that hold sections moved out of SKILL.md (PAR-13541). */
const MOVED_REFERENCES = ["heartbeat-procedure.md", "interactions-and-approvals.md", "workspaces-and-niche-workflows.md"];

/** SKILL.md plus the sections moved verbatim into references, for tests asserting skill guidance exists. */
export function readPaperclipSkillWithReferences(): string {
  const refDir = path.join(skillDir, "references");
  const refs = MOVED_REFERENCES;
  return [readFileSync(path.join(skillDir, "SKILL.md"), "utf8"), ...refs.map((f) => readFileSync(path.join(refDir, f), "utf8"))].join("\n\n");
}
