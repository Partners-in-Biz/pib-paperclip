import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPluginMigrationOrder } from '../check-pr-plugin-migration-order.mjs';

const m = (plugin, name) => `packages/plugins/${plugin}/migrations/${name}.sql`;

test('passes when the PR touches no plugin migrations', () => {
  assert.equal(checkPluginMigrationOrder([m('plugin-studio', '001_a')], []).passed, true);
});

test('passes when the new migration is the next number', () => {
  const result = checkPluginMigrationOrder(
    [m('plugin-studio', '001_a'), m('plugin-studio', '002_b')],
    [m('plugin-studio', '003_c')],
  );
  assert.equal(result.passed, true);
});

test('passes for the first migration of a new plugin', () => {
  assert.equal(checkPluginMigrationOrder([m('plugin-ads', '011_x')], [m('plugin-new', '001_init')]).passed, true);
});

test('fails on a duplicate number within the PR', () => {
  const result = checkPluginMigrationOrder(
    [m('plugin-studio', '001_a')],
    [m('plugin-studio', '002_b'), m('plugin-studio', '002_c')],
  );
  assert.equal(result.passed, false);
  assert.match(result.message, /duplicate number 2/);
});

test('fails when the number collides with the target branch', () => {
  const result = checkPluginMigrationOrder(
    [m('plugin-studio', '001_a'), m('plugin-studio', '002_b')],
    [m('plugin-studio', '002_c')],
  );
  assert.equal(result.passed, false);
  assert.match(result.message, /highest for plugin-studio \(2\)/);
});

test("other plugins' numbers do not affect the check", () => {
  const result = checkPluginMigrationOrder(
    [m('plugin-ads', '011_x'), m('plugin-studio', '001_a')],
    [m('plugin-studio', '002_b')],
  );
  assert.equal(result.passed, true);
});

test('pre-existing duplicates on the base do not fail an unrelated PR', () => {
  const result = checkPluginMigrationOrder(
    [m('plugin-ads', '002_a'), m('plugin-ads', '002_b'), m('plugin-studio', '001_a')],
    [m('plugin-studio', '002_b')],
  );
  assert.equal(result.passed, true);
});
