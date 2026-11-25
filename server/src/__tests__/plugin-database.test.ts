import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
  pointCoreReadsAtChatFreeViews,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";
import { buildPluginWorkerEnv, pluginLoader } from "../services/plugin-loader.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const multiMigrationPluginKey = "paperclip.dbfixture";
const llmWikiPluginKey = "paperclipai.plugin-llm-wiki";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin database tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("plugin database SQL validation", () => {
  it("allows namespace migrations with whitelisted public foreign keys", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
  });

  it("allows qualified index creation and namespace-scoped migration backfills", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE INDEX IF NOT EXISTS rows_issue_idx ON plugin_test.rows (issue_id)",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `
        WITH source_rows AS (
          SELECT id FROM plugin_test.rows
        )
        INSERT INTO plugin_test.row_copies (id)
        SELECT id FROM source_rows
        ON CONFLICT (id) DO NOTHING
        `,
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `
        UPDATE plugin_test.rows r
        SET copied_from_id = s.id
        FROM plugin_test.source_rows s
        WHERE s.id = r.id
        `,
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("keeps migration backfill writes scoped to the plugin namespace", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/fully qualified/i);
    expect(() =>
      validatePluginMigrationStatement(
        "WITH source_rows AS (SELECT id FROM plugin_test.rows) INSERT INTO public.issues (id) SELECT id FROM source_rows",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
    expect(() =>
      validatePluginMigrationStatement(
        "UPDATE public.issues SET title = 'bad'",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("rejects migrations that create public objects", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE public.rows (id uuid PRIMARY KEY)",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("allows whitelisted runtime reads but rejects public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute("UPDATE public.issues SET title = $1", "plugin_test")
    ).toThrow(/namespace/i);
  });

  it("targets anonymous DO blocks without rejecting do-prefixed aliases", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_test.rows",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement("DO $$ BEGIN END $$;", "plugin_test")
    ).toThrow(/disallowed/i);
  });
});

// PAR-12826 (chat privacy CP-4a, plan 4.9 A3): the scan sees every table reference.
describe("plugin SQL scan sees every table reference", () => {
  const ns = "plugin_test";
  // Each form names public.issues where the old keyword scan did not look.
  const forms: Array<[string, string]> = [
    ["after a comma", `SELECT x.id FROM ${ns}.rows x, public.issues i WHERE i.id = x.issue_id`],
    ["after a comma, upper case", `SELECT X.ID FROM ${ns}.ROWS X, PUBLIC.ISSUES I`],
    ["after a comma in a sub-query", `SELECT * FROM ${ns}.rows WHERE issue_id IN (SELECT i.id FROM ${ns}.rows r, public.issues i)`],
    ["after a comma in a WITH query", `WITH t AS (SELECT i.id FROM ${ns}.rows r, public.issues i) SELECT * FROM t`],
    ["after a comma that follows a JOIN ... ON", `SELECT 1 FROM ${ns}.rows a JOIN ${ns}.rows b ON a.id = b.id, public.issues i`],
    ["spaced around the dot", `SELECT 1 FROM public . issues`],
    ["quoted", `SELECT 1 FROM ${ns}.rows r, "public"."issues" i`],
    ["after ONLY", `SELECT 1 FROM ONLY public.issues`],
    ["after a comment", `SELECT 1 FROM ${ns}.rows r, /* note */ public.issues`],
    ["after an E-string that hides a quote", `SELECT E'\\'' AS a FROM ${ns}.rows r, public.issues i --'`],
  ];

  it.each(forms)("refuses an undeclared public.issues %s", (_form, statement) => {
    expect(() => validatePluginRuntimeQuery(statement, ns, [])).toThrow(/public\.issues.*not whitelisted/i);
  });

  it.each(forms)("accepts a declared public.issues %s and hands it to the replacement hook", (_form, statement) => {
    const refs = validatePluginRuntimeQuery(statement, ns, ["issues"]);
    expect(refs.map((ref) => [ref.schema, ref.table])).toEqual([["public", "issues"]]);
    expect(statement.slice(refs[0]!.start, refs[0]!.end).replace(/[\s"]/g, "").toLowerCase()).toBe("public.issues");
  });

  it("returns every declared core reference in statement order", () => {
    const statement = `SELECT 1 FROM public.issues i JOIN public.companies c ON c.id = i.company_id, public.issues j`;
    const refs = validatePluginRuntimeQuery(statement, ns, ["issues", "companies"]);
    expect(refs.map((ref) => statement.slice(ref.start, ref.end))).toEqual(["public.issues", "public.companies", "public.issues"]);
  });

  it("does not take text in a string literal for a table", () => {
    expect(validatePluginRuntimeQuery(`SELECT 'a, public.issues' AS note FROM ${ns}.rows`, ns, [])).toEqual([]);
  });

  it("refuses another schema after a comma", () => {
    expect(() => validatePluginRuntimeQuery(`SELECT 1 FROM ${ns}.rows r, plugin_other.secrets s`, ns, []))
      .toThrow(/cannot read schema "plugin_other"/);
  });

  it("refuses a public name outside a FROM or JOIN item", () => {
    expect(() => validatePluginRuntimeQuery(`SELECT $1::public.issues FROM ${ns}.rows`, ns, ["issues"]))
      .toThrow(/cannot mutate or define/i);
  });

  it("refuses a Unicode-escaped name, which could spell public", () => {
    expect(() => validatePluginRuntimeQuery(`SELECT 1 FROM ${ns}.rows r, U&"\\0070ublic".issues i`, ns, ["issues"]))
      .toThrow(/Unicode-escaped/);
  });

  it("checks a comma item in a plugin migration against the manifest", () => {
    const view = `CREATE VIEW ${ns}.open_rows AS SELECT r.id FROM ${ns}.rows r, public.issues i WHERE i.id = r.issue_id`;
    expect(() => validatePluginMigrationStatement(view, ns, [])).toThrow(/public\.issues.*not whitelisted/i);
    expect(() => validatePluginMigrationStatement(view, ns, ["issues"])).not.toThrow();
  });

  // PAR-12843 (chat privacy CP-4b-2): each scanned form reads the chat-free view.
  it.each(forms)("points a declared public.issues %s at plugin_core_read.issues", (_form, statement) => {
    const rewritten = pointCoreReadsAtChatFreeViews(statement, validatePluginRuntimeQuery(statement, ns, ["issues"]), {
      keepForeignKeyTargets: false,
    });
    expect(rewritten).toContain(`"plugin_core_read"."issues"`);
    expect(rewritten.replace(/[\s"]|\/\*.*?\*\//g, "").toLowerCase()).not.toContain("public.issues");
    // A plugin cannot name the views itself; only the host points at them.
    expect(() => validatePluginRuntimeQuery(rewritten, ns, ["issues"])).toThrow(/cannot read schema "plugin_core_read"/);
  });

  it("rewrites the three chat tables only, and keeps a migration's foreign key target", () => {
    const statement = `SELECT 1 FROM public.issues i JOIN public.issue_comments c ON true, "public"."heartbeat_runs" r, public.companies co`;
    const refs = validatePluginRuntimeQuery(statement, ns, ["issues", "issue_comments", "heartbeat_runs", "companies"]);
    expect(pointCoreReadsAtChatFreeViews(statement, refs, { keepForeignKeyTargets: false })).toBe(
      `SELECT 1 FROM "plugin_core_read"."issues" i JOIN "plugin_core_read"."issue_comments" c ON true, `
        + `"plugin_core_read"."heartbeat_runs" r, public.companies co`,
    );
    const migration = `CREATE TABLE ${ns}.marks (issue_id uuid REFERENCES public.issues(id))`;
    const migrationRefs = validatePluginMigrationStatement(migration, ns, ["issues"]);
    expect(pointCoreReadsAtChatFreeViews(migration, migrationRefs, { keepForeignKeyTargets: true })).toBe(migration);
  });

  it("keeps the forms plugins use today", () => {
    for (const statement of [
      `SELECT EXTRACT(EPOCH FROM now() - r.created_at) FROM ${ns}.rows r`,
      `SELECT 1 FROM ${ns}.rows r CROSS JOIN LATERAL jsonb_array_elements(r.data) e, unnest($1::uuid[]) u(id)`,
      `SELECT 1 FROM ${ns}.rows r WHERE coalesce(r.a IS DISTINCT FROM $1, r.flag)`,
      `WITH RECURSIVE tree AS (SELECT i.id FROM public.issues i UNION ALL SELECT c.id FROM public.issues c JOIN tree ON c.parent_id = tree.id) SELECT * FROM tree`,
    ]) {
      expect(() => validatePluginRuntimeQuery(statement, ns, ["issues"])).not.toThrow();
    }
  });
});

describe("buildPluginWorkerEnv", () => {
  const instanceInfo = {
    deploymentMode: "authenticated",
    deploymentExposure: "public",
  };

  it("forwards only granted variables to a plugin that registers no environment driver", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: [] },
      instanceInfo,
      grantedEnvVars: ["PROVIDER_ORIGIN", "PROVIDER_BLANK", "PROVIDER_MISSING"],
      processEnv: { PROVIDER_ORIGIN: "https://provider.test", PROVIDER_BLANK: " ", DATABASE_URL: "postgres://host", OPENAI_API_KEY: "openai-token" },
    });
    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      PROVIDER_ORIGIN: "https://provider.test",
    });
  });

  it("passes only model provider keys through to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        ANTHROPIC_API_KEY: "anthropic-token",
        OPENAI_API_KEY: "openai-token",
        GEMINI_API_KEY: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      ANTHROPIC_API_KEY: "anthropic-token",
      OPENAI_API_KEY: "openai-token",
    });
  });

  it("passes in-cluster Kubernetes service-discovery vars to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        KUBERNETES_SERVICE_PORT: "443",
        KUBERNETES_SERVICE_PORT_HTTPS: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
  });

  it("forwards only operator-listed env vars, and never PAPERCLIP_* ones", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.page.register"] },
      instanceInfo,
      processEnv: {
        PAPERCLIP_PLUGIN_WORKER_ENV_PASSTHROUGH: " PIB_STUDIO_FAKE_PROVIDER, PAPERCLIP_SECRET,bad-name,EMPTY_ONE",
        PIB_STUDIO_FAKE_PROVIDER: "1",
        PAPERCLIP_SECRET: "host-secret",
        EMPTY_ONE: " ",
        OPENAI_API_KEY: "openai-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      PIB_STUDIO_FAKE_PROVIDER: "1",
    });
  });

  it("forwards nothing extra when the passthrough list is unset", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.page.register"] },
      instanceInfo,
      processEnv: { PIB_STUDIO_FAKE_PROVIDER: "1" },
    });

    expect(env).toEqual({ PAPERCLIP_DEPLOYMENT_MODE: "authenticated", PAPERCLIP_DEPLOYMENT_EXPOSURE: "public" });
  });

  it("does not pass provider keys to non-environment plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.sidebar.register"] },
      instanceInfo,
      processEnv: {
        OPENAI_API_KEY: "openai-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });

  it.each([
    { packagePath: null, packageName: "@paperclipai/plugin-createos", driverKey: "createos", allowed: true },
    { packagePath: "/app/packages/plugins/sandbox-providers/createos", packageName: "@paperclipai/plugin-createos", driverKey: "createos", allowed: true },
    { packagePath: "/home/operator/plugins/fake-createos", packageName: "@paperclipai/plugin-createos", driverKey: "createos", allowed: false },
    { packagePath: null, packageName: "@acme/plugin-createos", driverKey: "createos", allowed: false },
    { packagePath: null, packageName: "@paperclipai/plugin-createos", driverKey: "daytona", allowed: false },
  ])("confines the CreateOS fallback credential to its trusted worker: $packageName / $packagePath / $driverKey", ({ allowed, driverKey, ...installation }) => {
    const env = buildPluginWorkerEnv({
      ...installation,
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey }],
      },
      trustedLocalPluginRoots: ["/app/packages/plugins"],
      instanceInfo,
      processEnv: { CREATEOS_API_KEY: "createos-token", DAYTONA_API_KEY: "daytona-token" },
    });
    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      ...(allowed ? { CREATEOS_API_KEY: "createos-token" } : {}),
    });
  });

  it.each([
    { packagePath: null, packageName: "@paperclipai/plugin-boxd", driverKey: "boxd", allowed: true },
    { packagePath: "/app/packages/plugins/sandbox-providers/boxd", packageName: "@paperclipai/plugin-boxd", driverKey: "boxd", allowed: true },
    { packagePath: "/home/operator/plugins/fake-boxd", packageName: "@paperclipai/plugin-boxd", driverKey: "boxd", allowed: false },
    { packagePath: null, packageName: "@acme/plugin-boxd", driverKey: "boxd", allowed: false },
    { packagePath: null, packageName: "@paperclipai/plugin-boxd", driverKey: "daytona", allowed: false },
  ])("confines the boxd fallback credential to its trusted worker: $packageName / $packagePath / $driverKey", ({ allowed, driverKey, ...installation }) => {
    const env = buildPluginWorkerEnv({
      ...installation,
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey }],
      },
      trustedLocalPluginRoots: ["/app/packages/plugins"],
      instanceInfo,
      processEnv: { BOXD_API_KEY: "boxd-token", DAYTONA_API_KEY: "daytona-token" },
    });
    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      ...(allowed ? { BOXD_API_KEY: "boxd-token" } : {}),
    });
  });

  it("passes a first-party sandbox provider's documented credential env var to its own worker", () => {
    const env = buildPluginWorkerEnv({
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "daytona" }],
      },
      packageName: "@paperclipai/plugin-daytona",
      packagePath: null,
      instanceInfo,
      processEnv: {
        DAYTONA_API_KEY: "daytona-token",
        NOVITA_API_KEY: "novita-token",
        E2B_API_KEY: " ",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      DAYTONA_API_KEY: "daytona-token",
    });
  });

  it("passes the credential to a first-party plugin installed from the bundled catalog", () => {
    const env = buildPluginWorkerEnv({
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "daytona" }],
      },
      packageName: "@paperclipai/plugin-daytona",
      packagePath: "/app/packages/plugins/sandbox-providers/daytona",
      trustedLocalPluginRoots: ["/app/packages/plugins"],
      instanceInfo,
      processEnv: {
        DAYTONA_API_KEY: "daytona-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      DAYTONA_API_KEY: "daytona-token",
    });
  });

  it("does not pass the credential to a local plugin that self-declares the first-party name", () => {
    const env = buildPluginWorkerEnv({
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "daytona" }],
      },
      packageName: "@paperclipai/plugin-daytona",
      packagePath: "/home/operator/.paperclip/plugins/fake-daytona",
      trustedLocalPluginRoots: ["/app/packages/plugins"],
      instanceInfo,
      processEnv: {
        DAYTONA_API_KEY: "daytona-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });

  it("does not pass a credential to a third-party plugin that claims a first-party driver key", () => {
    const env = buildPluginWorkerEnv({
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "daytona" }],
      },
      packageName: "@acme/plugin-fake-daytona",
      instanceInfo,
      processEnv: {
        DAYTONA_API_KEY: "daytona-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });

  it("does not pass a credential when the first-party package omits its expected driver key", () => {
    const env = buildPluginWorkerEnv({
      manifest: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "kubernetes" }],
      },
      packageName: "@paperclipai/plugin-daytona",
      instanceInfo,
      processEnv: {
        DAYTONA_API_KEY: "daytona-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });
});

describeEmbeddedPostgres("plugin database namespaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-db-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    for (const pluginKey of ["paperclip.dbtest", "paperclip.escape", "paperclip.refresh", multiMigrationPluginKey, llmWikiPluginKey]) {
      const namespace = derivePluginDatabaseNamespace(pluginKey);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    }
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${derivePluginDatabaseNamespace(llmWikiPluginKey, "llm_wiki")}" CASCADE`));
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await db.delete(issueRelations);
    await db.execute(sql`DELETE FROM heartbeat_runs`);
    await db.execute(sql`DELETE FROM issue_comments`);
    await db.delete(issues);
    await db.execute(sql`DELETE FROM agents`);
    await db.execute(sql`DELETE FROM "user" WHERE id LIKE 'chat-user-%'`);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createPluginPackage(manifest: PaperclipPluginManifestV1, migrationSql: string) {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-package-"));
    packageRoots.push(packageRoot);
    const migrationsDir = path.join(packageRoot, manifest.database!.migrationsDir);
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(path.join(migrationsDir, "001_init.sql"), migrationSql, "utf8");
    return packageRoot;
  }

  function llmWikiManifest(): PaperclipPluginManifestV1 {
    return {
      id: llmWikiPluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "LLM Wiki",
      description: "Local-file LLM Wiki plugin.",
      author: "Paperclip",
      categories: ["automation", "ui"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        namespaceSlug: "llm_wiki",
        migrationsDir: "migrations",
        coreReadTables: ["companies", "issues", "projects", "agents"],
      },
    };
  }

  async function createInstallablePluginPackage(
    pluginManifest: PaperclipPluginManifestV1,
    migrationSql: string,
  ) {
    const packageRoot = await createPluginPackage(pluginManifest, migrationSql);
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: pluginManifest.id,
        version: pluginManifest.version,
        type: "module",
        paperclipPlugin: { manifest: "./manifest.js" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "manifest.js"),
      `export default ${JSON.stringify(pluginManifest, null, 2)};\n`,
      "utf8",
    );
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n", "utf8");
    return packageRoot;
  }

  async function installPluginRecord(manifest: PaperclipPluginManifestV1) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    return pluginId;
  }

  function manifest(pluginKey = "paperclip.dbtest"): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "DB Test",
      description: "Exercises restricted plugin database access.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
    };
  }

  it("applies multi-file plugin migrations through the production validator", async () => {
    const pluginManifest = manifest(multiMigrationPluginKey);
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.source_rows (id uuid PRIMARY KEY, label text NOT NULL);`,
    );
    await writeFile(
      path.join(packageRoot, pluginManifest.database!.migrationsDir, "002_derived.sql"),
      `CREATE TABLE ${namespace}.derived_rows (
        id uuid PRIMARY KEY,
        source_id uuid NOT NULL REFERENCES ${namespace}.source_rows(id)
      );`,
      "utf8",
    );
    const pluginId = await installPluginRecord(pluginManifest);
    await pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(2);
  });

  it("applies the bundled LLM Wiki migrations through the production validator", async () => {
    const pluginManifest = llmWikiManifest();
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "plugin-llm-wiki");
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id, pluginManifest.database?.namespaceSlug);
    const pluginId = await installPluginRecord(pluginManifest);

    await pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations.map((migration) => migration.migrationKey)).toEqual([
      "001_llm_wiki.sql",
      "002_paperclip_distillation.sql",
      "003_spaces.sql",
    ]);

    const constraintRows = Array.from(
      await db.execute(
        sql<{ table_name: string; conname: string; columns: string[] }>`
          SELECT t.relname AS table_name, c.conname, array_agg(a.attname ORDER BY constraint_columns.ordinality)::text[] AS columns
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN unnest(c.conkey) WITH ORDINALITY AS constraint_columns(attnum, ordinality) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = constraint_columns.attnum
          WHERE c.connamespace = ${namespace}::regnamespace AND c.contype = 'u'
          GROUP BY t.relname, c.conname
          ORDER BY t.relname, c.conname
        `,
      ) as Iterable<{ table_name: string; conname: string; columns: string[] }>,
    );
    const constraints = constraintRows.map((row) => row.conname);
    const uniqueColumnSets = new Set(
      constraintRows.map((row) => `${row.table_name}:${row.columns.join(",")}`),
    );
    expect(constraints).toEqual(
      expect.arrayContaining([
        "wiki_pages_company_wiki_space_path_key",
        "distillation_cursors_company_wiki_space_scope_key",
        "distillation_work_items_company_wiki_space_idempotency_key",
        "page_bindings_company_wiki_space_page_path_key",
      ]),
    );
    expect(constraints).not.toContain("wiki_pages_company_id_wiki_id_path_key");
    expect(constraints).not.toContain("paperclip_distillation_cursor_company_id_wiki_id_source_sco_key");
    expect(constraints).not.toContain("paperclip_distillation_work_i_company_id_wiki_id_idempotenc_key");
    expect(constraints).not.toContain("paperclip_page_bindings_company_id_wiki_id_page_path_key");
    expect(uniqueColumnSets).not.toContain("wiki_pages:company_id,wiki_id,path");
    expect(uniqueColumnSets).not.toContain("paperclip_distillation_cursors:company_id,wiki_id,source_scope,scope_key,source_kind");
    expect(uniqueColumnSets).not.toContain("paperclip_distillation_work_items:company_id,wiki_id,idempotency_key");
    expect(uniqueColumnSets).not.toContain("paperclip_page_bindings:company_id,wiki_id,page_path");
  });

  it("applies migrations once and allows whitelisted core joins at runtime", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `
      CREATE TABLE ${namespace}.mission_rows (
        id uuid PRIMARY KEY,
        issue_id uuid NOT NULL REFERENCES public.issues(id),
        label text NOT NULL
      );
      `,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Joined issue",
      status: "todo",
      priority: "medium",
      identifier: "TST-1",
    });

    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.mission_rows (id, issue_id, label) VALUES ($1, $2, $3)`,
      [randomUUID(), issueId, "alpha"],
    );
    const rows = await pluginDb.query<{ label: string; title: string }>(
      pluginId,
      `SELECT m.label, i.title FROM ${namespace}.mission_rows m JOIN public.issues i ON i.id = m.issue_id`,
    );
    expect(rows).toEqual([{ label: "alpha", title: "Joined issue" }]);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(1);
  });

  it("rejects runtime writes to public core tables", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.notes (id uuid PRIMARY KEY, body text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await expect(
      pluginDb.execute(pluginId, "UPDATE public.issues SET title = $1", ["bad"]),
    ).rejects.toThrow(/plugin namespace/i);
  });

  it("records a failed migration when SQL escapes the plugin namespace", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const packageRoot = await createPluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const pluginId = await installPluginRecord(pluginManifest);

    await expect(
      pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot),
    ).rejects.toThrow(/public\.plugin_escape|public/i);

    const [migration] = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginId, pluginId));
    expect(migration?.status).toBe("failed");
  });

  it("rolls back plugin install when migration validation fails", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ localPath: packageRoot }))
      .rejects.toThrow(/public\.plugin_escape|public/i);

    const installedPlugins = await db
      .select()
      .from(plugins)
      .where(eq(plugins.pluginKey, pluginManifest.id));
    const namespaces = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginKey, pluginManifest.id));
    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginKey, pluginManifest.id));
    const schemaRows = Array.from(
      await db.execute(
        sql<{ schema_name: string }>`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${namespace}`,
      ) as Iterable<{ schema_name: string }>,
    );

    expect(installedPlugins).toHaveLength(0);
    expect(namespaces).toHaveLength(0);
    expect(migrations).toHaveLength(0);
    expect(schemaRows).toHaveLength(0);
  });

  it("refreshes persisted manifests from disk before activation", async () => {
    const staleManifest = manifest("paperclip.refresh");
    const refreshedManifest: PaperclipPluginManifestV1 = {
      ...staleManifest,
      capabilities: [...staleManifest.capabilities, "agent.tools.register"],
      database: {
        ...staleManifest.database!,
        coreReadTables: ["companies"],
      },
      tools: [
        {
          name: "db-smoke",
          displayName: "DB Smoke",
          description: "Exercises plugin tool registration worker lookup.",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    };
    const namespace = derivePluginDatabaseNamespace(refreshedManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      refreshedManifest,
      `
      CREATE TABLE ${namespace}.company_refs (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES public.companies(id)
      );
      `,
    );
    const pluginId = await installPluginRecord(staleManifest);
    await db
      .update(plugins)
      .set({
        packagePath: packageRoot,
        status: "ready",
      })
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    const toolDispatcher = {
      registerPluginTools: vi.fn(),
    };
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, {
      workerManager,
      eventBus: {
        forPlugin: vi.fn(() => ({})),
        subscriptionCount: vi.fn(() => 0),
      },
      jobScheduler: {
        registerPlugin: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      jobStore: {
        syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
      },
      toolDispatcher,
      lifecycleManager: {
        markError: vi.fn().mockResolvedValue(undefined),
      },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: {
        instanceId: "test-instance",
        hostVersion: "1.0.0",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      },
    } as never);

    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    expect(workerManager.startWorker).toHaveBeenCalledWith(
      pluginId,
      expect.objectContaining({
        databaseNamespace: namespace,
        env: {
          PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
          PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
        },
        manifest: expect.objectContaining({
          database: expect.objectContaining({ coreReadTables: ["companies"] }),
        }),
      }),
    );
    expect(toolDispatcher.registerPluginTools).toHaveBeenCalledWith(
      refreshedManifest.id,
      expect.objectContaining({
        tools: refreshedManifest.tools,
      }),
      pluginId,
    );
    const [plugin] = await db
      .select()
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    expect(plugin?.manifestJson.database?.coreReadTables).toEqual(["companies"]);
  });

  it("rejects checksum changes for already applied migrations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await writeFile(
      path.join(packageRoot, "migrations", "001_init.sql"),
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY, note text);`,
      "utf8",
    );

    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
      .rejects.toThrow(/checksum mismatch/i);
  });

  // PAR-12826 (chat privacy CP-4a): both forms run, not only read.
  async function seedCoreIssue(title: string) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "TST", requireBoardApprovalForNewAgents: false });
    await db.insert(issues).values({ id: issueId, companyId, title, status: "todo", priority: "medium", identifier: "TST-1" });
    return issueId;
  }

  async function installWithTable(pluginKey: string, coreReadTables: string[], tableSql: string) {
    const pluginManifest = { ...manifest(pluginKey), database: { migrationsDir: "migrations", coreReadTables } } as PaperclipPluginManifestV1;
    const namespace = derivePluginDatabaseNamespace(pluginKey);
    const packageRoot = await createPluginPackage(pluginManifest, tableSql.replaceAll("NS", namespace));
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    return { pluginId, namespace, pluginDb };
  }

  it("runs a declared public.issues after a comma and refuses it undeclared", async () => {
    const issueId = await seedCoreIssue("Comma issue");
    const table = "CREATE TABLE NS.marks (id uuid PRIMARY KEY, issue_id uuid NOT NULL, label text NOT NULL);";
    const declared = await installWithTable("paperclip.dbtest", ["issues"], table);
    await declared.pluginDb.execute(declared.pluginId, `INSERT INTO ${declared.namespace}.marks VALUES ($1, $2, $3)`, [randomUUID(), issueId, "alpha"]);
    const statement = `SELECT m.label, i.title FROM ${declared.namespace}.marks m, public.issues i WHERE i.id = m.issue_id`;

    expect(validatePluginRuntimeQuery(statement, declared.namespace, ["issues"]).map((ref) => ref.table)).toEqual(["issues"]);
    await expect(declared.pluginDb.query(declared.pluginId, statement)).resolves.toEqual([{ label: "alpha", title: "Comma issue" }]);

    const undeclared = await installWithTable("paperclip.escape", [], table);
    await expect(
      undeclared.pluginDb.query(undeclared.pluginId, `SELECT i.title FROM ${undeclared.namespace}.marks m, public.issues i`),
    ).rejects.toThrow(/public\.issues.*not whitelisted/i);
  });

  it("never resolves a table named without a schema to public", async () => {
    await seedCoreIssue("Core issue");
    const plain = await installWithTable("paperclip.dbtest", ["issues"], "CREATE TABLE NS.marks (id uuid PRIMARY KEY);");
    // Drizzle wraps the Postgres error; its cause says the plain name found nothing.
    const missing = { cause: expect.objectContaining({ message: 'relation "issues" does not exist' }) };
    await expect(plain.pluginDb.query(plain.pluginId, "SELECT title FROM issues")).rejects.toMatchObject(missing);
    await expect(
      plain.pluginDb.execute(plain.pluginId, `INSERT INTO ${plain.namespace}.marks (id) SELECT id FROM issues`),
    ).rejects.toMatchObject(missing);

    // A plugin table named like a core table is the one a plain name reaches.
    const shadow = await installWithTable("paperclip.escape", [], "CREATE TABLE NS.issues (id uuid PRIMARY KEY, title text NOT NULL);");
    await shadow.pluginDb.execute(shadow.pluginId, `INSERT INTO ${shadow.namespace}.issues VALUES ($1, $2)`, [randomUUID(), "Plugin row"]);
    await expect(shadow.pluginDb.query(shadow.pluginId, "SELECT title FROM issues")).resolves.toEqual([{ title: "Plugin row" }]);

    // The plugin's search_path ends with its transaction.
    const after = Array.from((await db.execute(sql`SELECT title FROM issues`)) as Iterable<{ title: string }>);
    expect(after).toEqual([{ title: "Core issue" }]);
  });

  // PAR-12843 (chat privacy CP-4b-2, AC-P14): plugin SQL on the three chat tables reads plugin_core_read.
  async function seedChatAndTask() {
    const companyId = randomUUID(), agentId = randomUUID(), userId = `chat-user-${randomUUID()}`;
    const chatId = randomUUID(), taskId = randomUUID(), chatRunId = randomUUID();
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Chat privacy', 'CPV')`);
    await db.execute(sql`INSERT INTO agents (id, company_id, name, role, adapter_type)
      VALUES (${agentId}, ${companyId}, 'Agent A', 'engineer', 'process')`);
    await db.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, 'Person A', ${`${userId}@example.test`}, true, now(), now())`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, assignee_agent_id, status,
      conversation_agent_id, conversation_user_id, conversation_state)
      VALUES (${chatId}, ${companyId}, 'Chat with Agent A', ${agentId}, 'todo', ${agentId}, ${userId}, 'waiting')`);
    await db.execute(sql`INSERT INTO issues (id, company_id, title, status) VALUES (${taskId}, ${companyId}, 'Open task', 'todo')`);
    await db.execute(sql`INSERT INTO issue_comments (company_id, issue_id, author_user_id, body) VALUES
      (${companyId}, ${chatId}, ${userId}, 'chat message one'), (${companyId}, ${chatId}, ${userId}, 'chat message two'),
      (${companyId}, ${taskId}, ${userId}, 'task message')`);
    await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, finished_at, issue_id,
      error, stdout_excerpt, stderr_excerpt, result_json, context_snapshot)
      VALUES (${chatRunId}, ${companyId}, ${agentId}, 'succeeded', now(), ${chatId}, 'chat error', 'chat stdout',
      'chat stderr', ${JSON.stringify({ reply: "chat reply" })}::jsonb, ${JSON.stringify({ issueId: chatId })}::jsonb)`);
    const plugin = await installWithTable(
      "paperclip.dbtest",
      ["issues", "issue_comments", "heartbeat_runs"],
      "CREATE TABLE NS.marks (id uuid PRIMARY KEY, issue_id uuid NOT NULL REFERENCES public.issues(id));",
    );
    return { ...plugin, companyId, chatId, taskId, chatRunId };
  }

  it("AC-P14: a plugin that declares the three tables gets no chat, no chat message and no chat run text", async () => {
    const s = await seedChatAndTask();
    const q = (statement: string) => s.pluginDb.query<Record<string, unknown>>(s.pluginId, statement, [s.companyId]);
    const task = [{ id: s.taskId }];

    expect(await q("SELECT id FROM public.issues WHERE company_id = $1")).toEqual(task);
    expect(await q("SELECT body FROM public.issue_comments WHERE company_id = $1")).toEqual([{ body: "task message" }]);
    expect(await q(`SELECT id, error, stdout_excerpt, stderr_excerpt, result_json, context_snapshot
      FROM public.heartbeat_runs WHERE company_id = $1`)).toEqual([{
      id: s.chatRunId, error: null, stdout_excerpt: null, stderr_excerpt: null, result_json: null, context_snapshot: null,
    }]);

    const forms: Array<[string, string]> = [
      ["a join", "SELECT i.id FROM public.issue_comments c JOIN public.issues i ON i.id = c.issue_id WHERE i.company_id = $1"],
      ["a table after a comma", "SELECT i.id FROM public.issue_comments c, public.issues i WHERE i.id = c.issue_id AND c.company_id = $1"],
      ["a quoted name", `SELECT "id" FROM "public"."issues" WHERE company_id = $1`],
      ["the table name as qualifier", "SELECT issues.id FROM public.issues WHERE issues.company_id = $1"],
      ["an alias", "SELECT x.id FROM public.issues AS x WHERE x.company_id = $1"],
      ["a sub-query", "SELECT t.id FROM (SELECT id, company_id FROM public.issues) t WHERE t.company_id = $1"],
      ["a WITH query", "WITH open_rows AS (SELECT id FROM public.issues WHERE company_id = $1) SELECT id FROM open_rows"],
    ];
    for (const [form, statement] of forms) {
      expect(await q(statement), form).toEqual(task);
    }

    // A plain name is never public.issues (CP-4a search_path): refused with no such relation.
    await expect(q("SELECT id FROM issues WHERE company_id = $1"))
      .rejects.toMatchObject({ cause: expect.objectContaining({ message: 'relation "issues" does not exist' }) });
    // The host's own reads still see the chat.
    const core = Array.from((await db.execute(sql`SELECT count(*)::int AS n FROM public.issues`)) as Iterable<{ n: number }>);
    expect(core).toEqual([{ n: 2 }]);
  });

  it("AC-P14: a plugin migration view over public.issues has no chat, and its foreign key stays on public.issues", async () => {
    const s = await seedChatAndTask();
    const migration = `
      CREATE TABLE NS.marks (id uuid PRIMARY KEY, issue_id uuid NOT NULL REFERENCES public.issues(id));
      CREATE VIEW NS.task_titles AS SELECT i.id, i.title FROM public.issues i;
      CREATE VIEW NS.task_messages AS SELECT c.body FROM public.issue_comments c JOIN public.issues i ON i.id = c.issue_id;`;
    const viewPlugin = await installWithTable("paperclip.escape", ["issues", "issue_comments"], migration);
    const ns = viewPlugin.namespace;
    // Read as the host, with no runtime rewrite: the view itself is chat-free.
    const read = async (query: ReturnType<typeof sql>) => Array.from((await db.execute(query)) as Iterable<Record<string, unknown>>);
    expect(await read(sql.raw(`SELECT id, title FROM "${ns}".task_titles`))).toEqual([{ id: s.taskId, title: "Open task" }]);
    expect(await read(sql.raw(`SELECT body FROM "${ns}".task_messages`))).toEqual([{ body: "task message" }]);
    expect(await read(sql.raw(`SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = '"${ns}".marks'::regclass AND contype = 'f'`))).toEqual([{ target: "issues" }]);
    // The foreign key points at the real table, which holds the chat too.
    await viewPlugin.pluginDb.execute(viewPlugin.pluginId, `INSERT INTO ${ns}.marks VALUES ($1, $2)`, [randomUUID(), s.chatId]);
  });

  it("AC-P14: a plugin migration that names issues without a schema cannot reach public.issues", async () => {
    await seedChatAndTask();
    await expect(
      installWithTable("paperclip.escape", ["issues"], "CREATE TABLE NS.marks (id uuid PRIMARY KEY); CREATE VIEW NS.plain AS SELECT id FROM issues;"),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'relation "issues" does not exist' }) });
  });
});

describe("plugin database tests run under CI", () => {
  it.runIf(Boolean(process.env.CI))("has a real database under CI", () => {
    expect(embeddedPostgresSupport.supported).toBe(true);
  });
});
