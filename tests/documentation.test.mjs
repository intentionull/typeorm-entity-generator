import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-docs.mjs', import.meta.url));
const restricted = String.fromCharCode(67, 104, 97, 116, 71, 80, 84);
const abbreviation = String.fromCharCode(65, 73);

function check(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'schema-documentation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const before = Object.fromEntries(
    Object.keys(files).map((path) => [path, readFileSync(join(root, path))]),
  );
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.ifError(result.error);
  for (const [path, bytes] of Object.entries(before)) {
    assert.deepEqual(readFileSync(join(root, path)), bytes, `Check modified ${path}`);
  }
  return { ...result, output: result.stdout + result.stderr };
}

function fails(result, code, location) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(code));
  assert.ok(result.output.includes(location), result.output);
}

test('valid relative, encoded, image, root-relative, and external links pass without fetching', (t) => {
  const result = check(t, {
    'README.md':
      '[Guide](docs/guide.md#usage)\n[Example](</examples/schema sample.sql> "Example")\n![Diagram](docs/schema%20diagram.svg)\n[Remote](https://invalid.example/absent)\n[Mail](mailto:maintainer@example.invalid)\n[Heading](#overview)\n',
    'docs/guide.md': '# Usage\n[Home](../README.md)\n',
    'examples/schema sample.sql': 'CREATE TABLE accounts (id integer);\n',
    'docs/schema diagram.svg': '<svg />\n',
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PASS/);
});

test('missing linked examples fail with a source line and column', (t) => {
  fails(
    check(t, { 'README.md': '# Examples\n[Example](examples/missing.sql)\n' }),
    'DOC_LINK',
    'README.md:2:',
  );
});

test('reference-style links, images, collapsed and shortcut references are checked', (t) => {
  const result = check(t, {
    'README.md':
      '[Guide][manual]\n![Diagram][image]\n[manual][]\n[manual]\n\n[manual]: docs/guide.md "Guide"\n[image]: <docs/diagram.svg>\n',
    'docs/guide.md': '# Guide\n',
    'docs/diagram.svg': '<svg />\n',
  });
  assert.equal(result.status, 0, result.output);
  fails(
    check(t, { 'README.md': '[Guide][manual]\n\n[manual]: missing.md\n' }),
    'DOC_LINK',
    'README.md:1:',
  );
  fails(check(t, { 'README.md': '[Guide][undefined]\n' }), 'DOC_REFERENCE', 'README.md:1:');
});

test('code examples and escaped link syntax do not create false broken links', (t) => {
  const result = check(t, {
    'README.md':
      '`[Inline](missing.md)`\n\\[Escaped](missing.md)\n\n```md\n[Sample](absent.md)\n```\n\n~~~text\n[Sample][absent]\n~~~\n\n    [Indented](missing.md)\n',
  });
  assert.equal(result.status, 0, result.output);
});

test('numbered prose citations are not undefined reference links', (t) => {
  assert.equal(check(t, { 'README.md': 'Parser research [1][2][3].\n' }).status, 0);
  fails(check(t, { 'README.md': '[1][2]\n\n[2]: missing.md\n' }), 'DOC_LINK', 'README.md:1:');
});

test('fences need a closing marker of the same kind and sufficient length', (t) => {
  fails(check(t, { 'README.md': '# Example\n````ts\n```\n~~~\n' }), 'DOC_FENCE', 'README.md:2:');
  assert.equal(check(t, { 'README.md': '~~~~text\n~~~\n~~~~\n' }).status, 0);
});

test('restricted terminology is rejected in prose, code comments, identifiers, and package metadata', (t) => {
  for (const [path, text] of [
    ['README.md', `# Schema\n${restricted}\n`],
    ['src/entity.ts', `// ${restricted}\nexport const create${restricted}Entity = 1;\n`],
    ['package.json', JSON.stringify({ description: restricted })],
    ['tests/fixtures/generated/account.ts', `export class ${abbreviation}Account {}\n`],
    ['README.md', `\`\`\`text\n${restricted}\n\`\`\`\n`],
  ]) {
    fails(check(t, { [path]: text }), 'VOCABULARY', `${path}:`);
  }
});

test('restricted filenames fail but harmless substrings and domain identifiers pass', (t) => {
  const result = check(t, {
    'src/entity.ts':
      'const email = "paid";\nconst maintainSchema = "claim";\nclass AccountEntity {}\n',
  });
  assert.equal(result.status, 0, result.output);
  fails(
    check(t, { [`src/${restricted}Entity.ts`]: 'export {};\n' }),
    'VOCABULARY_PATH',
    `src/${restricted}Entity.ts:1:`,
  );
});

test('required legal notices and dependency/internal directories are exempt, not rewritten', (t) => {
  const result = check(t, {
    LICENSE: `Copyright ${restricted}\n`,
    'tests/fixtures/upstream/vendor/legal/NOTICE.txt': `${restricted}\n`,
    'node_modules/vendor/README.md': `[Missing](absent.md)\n${restricted}\n`,
    '.git/private.md': `${restricted}\n`,
    '.env': `${restricted}=secret\n`,
    'README.md': '# Schema\n',
  });
  assert.equal(result.status, 0, result.output);
});

test('upstream source is still inspected and reported without modifying original bytes', (t) => {
  fails(
    check(t, { 'tests/fixtures/upstream/vendor/original.dbml': `// ${restricted}\n` }),
    'VOCABULARY',
    'tests/fixtures/upstream/vendor/original.dbml:1:',
  );
});

test('links cannot escape the checkout and diagnostics have deterministic ordering', (t) => {
  const result = check(t, {
    'z.md': '[Missing](missing.md)\n',
    'a.md': '[Outside](../README.md)\n',
  });
  fails(result, 'DOC_LINK', 'a.md:1:');
  assert.ok(result.output.indexOf('a.md:1:') < result.output.indexOf('z.md:1:'), result.output);
});

test('missing roots fail clearly instead of reporting an empty pass', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'schema-missing-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, join(root, 'absent')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHECK_IO/);
});
