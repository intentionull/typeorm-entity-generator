import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function checkout(t, script) {
  const root = mkdtempSync(join(tmpdir(), 'schema-tooling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, 'scripts', script));
  return root;
}
function run(root, script, cwd = root) {
  return spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd, encoding: 'utf8' });
}

test('clean removes only checkout compiler output regardless of working directory', (t) => {
  const root = checkout(t, 'clean.mjs');
  mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  writeFileSync(join(root, 'dist', 'src', 'entity.js'), 'output');
  writeFileSync(join(root, 'schema.sql'), 'source');
  const result = run(root, 'clean.mjs', tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'dist')), false);
  assert.equal(readFileSync(join(root, 'schema.sql'), 'utf8'), 'source');
  assert.equal(run(root, 'clean.mjs').status, 0);
});

test('clean cannot remove external contents reached through a dist symlink', (t) => {
  const root = checkout(t, 'clean.mjs');
  const outside = mkdtempSync(join(tmpdir(), 'schema-output-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'keep.txt'), 'untouched');
  symlinkSync(outside, join(root, 'dist'), 'dir');
  const result = run(root, 'clean.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched');
});

test('license inventory checks metadata without rewriting the lockfile', (t) => {
  const root = checkout(t, 'license-inventory.mjs');
  const lock = JSON.stringify({
    packages: {
      '': { license: 'MIT' },
      'node_modules/example': { version: '1.0.0', license: 'Apache-2.0' },
    },
  });
  writeFileSync(join(root, 'package-lock.json'), lock);
  const result = run(root, 'license-inventory.mjs', tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /example\t1\.0\.0\tApache-2\.0/);
  assert.equal(readFileSync(join(root, 'package-lock.json'), 'utf8'), lock);
});

for (const license of ['ISC', '0BSD', 'BlueOak-1.0.0']) {
  test(`license inventory recognizes reviewed ${license} dependency metadata without rewriting it`, (t) => {
    const root = checkout(t, 'license-inventory.mjs');
    const lock = JSON.stringify({
      packages: { 'node_modules/example': { version: '1.0.0', license } },
    });
    writeFileSync(join(root, 'package-lock.json'), lock);
    const result = run(root, 'license-inventory.mjs');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`example\t1.0.0\t${license}`));
    assert.equal(readFileSync(join(root, 'package-lock.json'), 'utf8'), lock);
  });
}

for (const license of [undefined, 'GPL-3.0-only', 'UNKNOWN']) {
  test(`license inventory requires review for ${license ?? 'missing'} metadata`, (t) => {
    const root = checkout(t, 'license-inventory.mjs');
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0', license } } }),
    );
    const result = run(root, 'license-inventory.mjs');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Review/);
  });
}
