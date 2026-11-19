// Browser-test fixture (PAR-13267): an execution workspace exists only after an agent run,
// so the spec writes one row into the test server's embedded database and links the task.
// Usage: tsx member-restriction-seed-workspace.ts --config <config.json> --company <id> --project <id> --issue <id>
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "../../../packages/db/src/client.js";

const arg = (flag: string) => {
  const value = process.argv[process.argv.indexOf(flag) + 1];
  if (!process.argv.includes(flag) || !value) throw new Error(`missing ${flag}`);
  return value;
};

async function main() {
  const config = JSON.parse(readFileSync(path.resolve(arg("--config")), "utf8")) as {
    database?: { mode?: string; connectionString?: string; embeddedPostgresDataDir?: string };
  };
  const dbUrl = config.database?.mode === "postgres"
    ? config.database.connectionString!
    // postmaster.pid line 4 is the port of the running embedded server.
    : `postgres://paperclip:paperclip@127.0.0.1:${readFileSync(path.join(config.database!.embeddedPostgresDataDir!, "postmaster.pid"), "utf8").split(/\r?\n/)[3]}/paperclip`;
  // The postgres.js client under drizzle (`postgres` is not a dependency of tests/e2e).
  type Sql = (<T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>) & { end(): Promise<void> };
  const sql = (createDb(dbUrl) as unknown as { $client: Sql }).$client;
  const [company, project, issue] = [arg("--company"), arg("--project"), arg("--issue")];
  const [row] = await sql<{ id: string }[]>`
    insert into execution_workspaces (company_id, project_id, source_issue_id, mode, strategy_type, name, status)
    values (${company}, ${project}, ${issue}, 'shared_workspace', 'project_primary', 'MR workspace', 'active')
    returning id`;
  await sql`update issues set execution_workspace_id = ${row!.id} where id = ${issue} and company_id = ${company}`;
  await sql.end();
  process.stdout.write(row!.id);
}

void main();
