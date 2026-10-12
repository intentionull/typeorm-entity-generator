import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePostgres } from '../src/adapters/postgres.js';
import { emitPostgresEntities } from '../src/emit/postgres.js';
import { resolveNames } from '../src/resolve/names.js';
import type { ResolvedSchema } from '../src/resolve/model.js';

async function resolved(sql: string): Promise<ResolvedSchema> {
  const result = await normalizePostgres(sql, { dialect: 'postgres', target: 'postgres' });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('Invalid test SQL.');
  const names = resolveNames(result.schema);
  assert.equal(names.ok, true, JSON.stringify(names.diagnostics));
  if (!names.ok) throw new Error('Invalid test names.');
  return names.resolved;
}

const basic = `CREATE TABLE accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(254) NOT NULL UNIQUE,
  balance numeric(20, 4) NOT NULL DEFAULT 1234567890123456.1250,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);`;

test('emission returns deterministic relative files without mutating input or retaining state', async () => {
  const input = await resolved(basic);
  const before = structuredClone(input);
  const first = emitPostgresEntities(input);
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  if (!first.ok) return;
  assert.deepEqual(
    first.files.map((file) => file.path),
    ['accounts.entity.ts', 'index.ts'],
  );
  assert.deepEqual(input, before);
  assert.deepEqual(emitPostgresEntities(input), first);
  for (const file of first.files) {
    assert.equal(file.content.endsWith('\n'), true);
    assert.doesNotMatch(file.content, /\/tmp\/|\/home\/|synchronize|DataSource/);
  }
  first.files[0]!.content = 'changed';
  assert.notDeepEqual(emitPostgresEntities(input), first);
});

test('empty input emits an explicit empty registry', async () => {
  const result = emitPostgresEntities(await resolved(''));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.path, 'index.ts');
    assert.match(result.files[0]!.content, /export const entities = \[\];/);
  }
});

for (const [label, sql, message] of [
  ['table without a primary key', 'CREATE TABLE t (id int);', /primary key/],
  ['unbounded bpchar', 'CREATE TABLE t (id int PRIMARY KEY, value "bpchar");', /bpchar/],
  [
    'reordered primary key',
    'CREATE TABLE t (a int, b int, PRIMARY KEY (b,a));',
    /primary key order/,
  ],
  [
    'non-primary identity',
    'CREATE TABLE t (id int PRIMARY KEY, sequence int GENERATED ALWAYS AS IDENTITY);',
    /identity/,
  ],
  [
    'MATCH FULL',
    'CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int, FOREIGN KEY(a_id) REFERENCES a(id) MATCH FULL);',
    /MATCH FULL/,
  ],
  [
    'different integer widths in a relation',
    'CREATE TABLE a (id bigint PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id));',
    /type/,
  ],
  [
    'different character widths in a relation',
    'CREATE TABLE a (id varchar(12) PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id varchar(24) REFERENCES a(id));',
    /type/,
  ],
  [
    'cross-schema enum',
    "CREATE SCHEMA labels; CREATE TYPE labels.state AS ENUM ('open'); CREATE TABLE t (id int PRIMARY KEY, state labels.state);",
    /enum/,
  ],
  [
    'unused enum',
    "CREATE TYPE state AS ENUM ('open'); CREATE TABLE t (id int PRIMARY KEY);",
    /enum/,
  ],
  ['unused namespace', 'CREATE SCHEMA unused; CREATE TABLE t (id int PRIMARY KEY);', /namespace/],
  ['quoted-dot table name', 'CREATE TABLE "t.x" (id int PRIMARY KEY);', /identifier/],
  ['quoted-quote column name', 'CREATE TABLE t (id int PRIMARY KEY, "a""b" text);', /identifier/],
] as const) {
  test(`unrepresentable ${label} fails with a located diagnostic and no partial files`, async () => {
    const input = await resolved(sql);
    const result = emitPostgresEntities(input);
    assert.equal(result.ok, false);
    assert.equal('files' in result, false);
    assert.equal(result.diagnostics[0]?.code, 'EMIT_UNSUPPORTED');
    assert.equal(result.diagnostics[0]?.severity, 'error');
    assert.match(result.diagnostics[0]!.message, message);
    assert.equal(Number.isInteger(result.diagnostics[0]!.location.offset), true);
  });
}

for (const onDelete of ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']) {
  for (const onUpdate of ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']) {
    if (onDelete !== 'SET DEFAULT' && onUpdate !== 'SET DEFAULT') continue;
    test(`SET DEFAULT action pair ${onDelete}/${onUpdate} is rejected before generating uncompilable files`, async () => {
      const input = await resolved(`CREATE TABLE owners (id int PRIMARY KEY);
        CREATE TABLE items (id int PRIMARY KEY, owner_id int DEFAULT 1,
          FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE ${onDelete} ON UPDATE ${onUpdate});`);
      const result = emitPostgresEntities(input);
      assert.equal(result.ok, false);
      assert.equal('files' in result, false);
      assert.ok(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'EMIT_UNSUPPORTED' &&
            diagnostic.message.includes('SET DEFAULT') &&
            diagnostic.location.offset > 0,
        ),
      );
    });
  }
}

test('relation property collisions fail rather than renaming scalar properties', async () => {
  const input = await resolved(
    'CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES a(id), relation_1 text);',
  );
  const result = emitPostgresEntities(input);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, 'EMIT_COLLISION');
  assert.equal('files' in result, false);
});

test('inconsistent internal mappings fail with diagnostics rather than throwing', async () => {
  const input = await resolved(basic);
  input.entities[0]!.columns.pop();
  const result = emitPostgresEntities(input);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, 'EMIT_INVALID');
  assert.equal('files' in result, false);
});

test('registry export collisions require an explicit class override', async () => {
  const input = await resolved('CREATE TABLE entities (id int PRIMARY KEY);');
  input.entities[0]!.className = 'entities';
  const result = emitPostgresEntities(input);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, 'EMIT_COLLISION');
});
