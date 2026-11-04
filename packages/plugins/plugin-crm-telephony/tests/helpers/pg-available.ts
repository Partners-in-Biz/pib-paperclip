import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const EMBEDDED = join(here, "../../../../db/node_modules/embedded-postgres/dist/index.js");

/**
 * True when embedded Postgres can run here: the package is installed and we are not root
 * (initdb/postgres refuse to run as root, e.g. on the deploy gate). pg specs use
 * `describe.skipIf(!pgAvailable)`.
 */
export const pgAvailable: boolean =
  existsSync(EMBEDDED) && !(typeof process.getuid === "function" && process.getuid() === 0);
