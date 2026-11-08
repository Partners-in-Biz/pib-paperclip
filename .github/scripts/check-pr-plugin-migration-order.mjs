#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_MIGRATION_PATTERN = /^packages\/plugins\/([^/]+)\/migrations\/(\d+)_[^/]+\.sql$/;

function parse(file) {
  const match = file.match(PLUGIN_MIGRATION_PATTERN);
  return match ? { file, plugin: match[1], number: Number.parseInt(match[2], 10) } : null;
}

function groupByPlugin(migrations) {
  const groups = new Map();
  for (const migration of migrations) {
    if (!groups.has(migration.plugin)) groups.set(migration.plugin, []);
    groups.get(migration.plugin).push(migration);
  }
  return groups;
}

/**
 * Plugin migrations are numbered per plugin (packages/plugins/<name>/migrations/NNN_*.sql).
 * Each plugin's new migrations must be above the target branch's highest number for that
 * plugin, and must not reuse a number within the PR. Other plugins are not affected.
 */
export function checkPluginMigrationOrder(baseFiles, prFiles) {
  const prMigrations = prFiles.map(parse).filter(Boolean);
  if (prMigrations.length === 0) {
    return { passed: true, message: 'No new plugin migrations in this PR.' };
  }

  const baseByPlugin = groupByPlugin(baseFiles.map(parse).filter(Boolean));
  const problems = [];

  for (const [plugin, added] of groupByPlugin(prMigrations)) {
    const latest = (baseByPlugin.get(plugin) ?? []).reduce(
      (max, migration) => Math.max(max, migration.number),
      0,
    );
    const seen = new Map();
    for (const migration of added) {
      if (migration.number <= latest) {
        problems.push(
          `${migration.file}: number ${migration.number} is not above the target branch's highest for ${plugin} (${latest}). Renumber it to ${latest + 1} or higher.`,
        );
      }
      if (seen.has(migration.number)) {
        problems.push(
          `${migration.file}: duplicate number ${migration.number} in ${plugin} (also ${seen.get(migration.number)}).`,
        );
      }
      seen.set(migration.number, migration.file);
    }
  }

  if (problems.length === 0) {
    return { passed: true, message: 'All new plugin migrations follow the target branch.' };
  }
  return {
    passed: false,
    message: ['Plugin migration numbers must follow the target branch with no duplicates:', ...problems.map((p) => `- ${p}`)].join('\n'),
  };
}

function gitPaths(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function main() {
  const [baseSha, headSha] = process.argv.slice(2);
  const shaPattern = /^[0-9a-f]{40}$/i;
  if (!shaPattern.test(baseSha ?? '') || !shaPattern.test(headSha ?? '')) {
    console.error('Usage: check-pr-plugin-migration-order.mjs <40-character base SHA> <40-character head SHA>');
    process.exit(2);
  }
  const spec = ['packages/plugins/*/migrations/*.sql'];
  const baseFiles = gitPaths(['ls-tree', '-r', '--name-only', '-z', baseSha, '--', ...spec]);
  const prFiles = gitPaths(['diff', '--name-only', '--diff-filter=A', '-z', `${baseSha}...${headSha}`, '--', ...spec]);
  const result = checkPluginMigrationOrder(baseFiles, prFiles);
  if (result.passed) {
    console.log(result.message);
    return;
  }
  const encoded = result.message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.error(`::error title=Plugin migration numbers must follow the target branch::${encoded}`);
  console.error(result.message);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
