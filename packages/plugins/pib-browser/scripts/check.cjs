'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2];
const files = (dir) => {
  const d = path.join(root, dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.cjs')).map((f) => path.join(d, f)) : [];
};
if (mode === 'syntax') {
  for (const f of ['src', 'bin', 'scripts', 'test'].flatMap(files)) {
    if (spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' }).status !== 0) {
      console.error(`syntax error: ${path.relative(root, f)}`);
      process.exit(1);
    }
  }
} else if (mode === 'load') {
  const mods = files('src').filter((f) => path.basename(f) !== 'driver-playwright.cjs');
  try {
    mods.forEach((f) => require(f));
    JSON.parse(fs.readFileSync(path.join(root, 'sites.json'), 'utf8'));
  } catch (e) {
    console.error(`load failed: ${e.message}`);
    process.exit(1);
  }
  console.log(`pib-browser build ok: ${mods.length} modules`);
} else {
  console.error('usage: check.cjs syntax|load');
  process.exit(2);
}
