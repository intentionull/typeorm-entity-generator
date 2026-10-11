import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normalizeDbml } from '../src/adapters/dbml.js';
import { normalizePostgres } from '../src/adapters/postgres.js';
import type { DbmlOptions, SchemaDocument } from '../src/schema/model.js';

const options: DbmlOptions = { target: 'postgres' };
const project = "Project p { database_type: 'PostgreSQL' }\n";
function schema(body: string): SchemaDocument {
  const result = normalizeDbml(project + body, options);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('Expected schema');
  return result.schema;
}
function failure(body: string, code: string) {
  const result = normalizeDbml(project + body, options);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, code);
  assert.equal('schema' in result, false);
  assert.ok(result.diagnostics[0]?.message);
  return result.diagnostics[0];
}
function physical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(physical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'location')
        .map(([k, v]) => [k, physical(v)]),
    );
  return value;
}
for (const name of ['basic', 'tenant', 'quoted']) {
  test(`DBML and SQL preserve equivalent ${name} physical facts`, async () => {
    const dbml = readFileSync(`tests/fixtures/pairs/${name}.dbml`, 'utf8');
    const sql = readFileSync(`tests/fixtures/pairs/${name}.sql`, 'utf8');
    const left = normalizeDbml(dbml, options);
    const right = await normalizePostgres(sql, { dialect: 'postgres', target: 'postgres' });
    assert.equal(left.ok, true, JSON.stringify(left.diagnostics));
    assert.equal(right.ok, true, JSON.stringify(right.diagnostics));
    if (left.ok && right.ok) assert.deepEqual(physical(left.schema), physical(right.schema));
  });
}

test('DBML keeps source order, exact identifiers, forward enum and table references', () => {
  const result = schema(
    `Table z.child { id int [pk]\n parent bigint [ref: > z.parent.id]\n status z.status }\nEnum z.status { pending\n "customer's hold" }\nTable z.parent { id bigint [pk] }`,
  );
  assert.deepEqual(result.namespaces, ['public', 'z']);
  assert.deepEqual(
    result.tables.map((t) => t.name),
    ['child', 'parent'],
  );
  assert.deepEqual(result.enums[0]?.values, ['pending', "customer's hold"]);
  assert.deepEqual(result.tables[0]?.columns[2]?.type, {
    kind: 'enum',
    schema: 'z',
    name: 'status',
    modifiers: [],
  });
  assert.equal(result.tables[0]?.foreignKeys[0]?.target.name, 'parent');
});

for (const [input, output, modifiers] of [
  ['integer', 'int4', []],
  ['smallint', 'int2', []],
  ['bigint', 'int8', []],
  ['boolean', 'bool', []],
  ['varchar(32)', 'varchar', [32]],
  ['char(2)', 'bpchar', [2]],
  ['decimal(12,2)', 'numeric', [12, 2]],
  ['numeric(5,-2)', 'numeric', [5, -2]],
  ['real', 'float4', []],
  ['"double precision"', 'float8', []],
  ['"timestamp with time zone"', 'timestamptz', []],
  ['timestamp(3)', 'timestamp', [3]],
  ['text', 'text', []],
  ['uuid', 'uuid', []],
  ['jsonb', 'jsonb', []],
  ['date', 'date', []],
  ['bytea', 'bytea', []],
] as const) {
  test(`DBML PostgreSQL type ${input}`, () => {
    assert.deepEqual(schema(`Table t { v ${input} }`).tables[0]?.columns[0]?.type, {
      kind: 'builtin',
      schema: 'pg_catalog',
      name: output,
      modifiers,
    });
  });
}

for (const [input, expected] of [
  ['9007199254740993', { kind: 'literal', type: 'number', value: '9007199254740993' }],
  ['-1.20e+5', { kind: 'literal', type: 'number', value: '-1.20e+5' }],
  ['0', { kind: 'literal', type: 'number', value: '0' }],
  ['true', { kind: 'literal', type: 'boolean', value: true }],
  ['false', { kind: 'literal', type: 'boolean', value: false }],
  ['null', { kind: 'literal', type: 'null', value: null }],
  ["'null'", { kind: 'literal', type: 'string', value: 'null' }],
  ["'false'", { kind: 'literal', type: 'string', value: 'false' }],
  ["''", { kind: 'literal', type: 'string', value: '' }],
  ['`now()`', { kind: 'expression', sql: 'now()' }],
] as const) {
  test(`DBML default ${input} retains its category and value`, () => {
    assert.deepEqual(
      schema(`Table t { v text [default: ${input}] }`).tables[0]?.columns[0]?.default,
      expected,
    );
  });
}

test('DBML numeric default recovery ignores notes, comments and quoted default text', () => {
  const result = schema(
    `Table t { v numeric [note: 'default: 42', /* default: 8 */ default: 9007199254740993] }`,
  );
  assert.deepEqual(result.tables[0]?.columns[0]?.default, {
    kind: 'literal',
    type: 'number',
    value: '9007199254740993',
  });
});

test('DBML nullability and explicit composite keys do not infer extra uniqueness', () => {
  const t = schema(`Table t { a int [pk]\n b int [pk]\n c text [unique]\n d text [null] }`)
    .tables[0];
  assert.deepEqual(t?.primaryKey?.columns, ['a', 'b']);
  assert.deepEqual(
    t?.columns.map((c) => c.nullable),
    [false, false, true, true],
  );
  assert.deepEqual(
    t?.uniqueKeys.map((k) => k.columns),
    [['c']],
  );
});

test('DBML distinguishes unique constraints from explicit btree indexes', () => {
  const t = schema(
    `Table t { a int\n b int\n indexes { a [unique, name: 'u']\n b [unique, type: btree, name: 'i'] } }`,
  ).tables[0];
  assert.equal(t?.uniqueKeys[0]?.name, 'u');
  assert.deepEqual(
    t?.indexes.map((i) => [i.name, i.unique, i.method]),
    [['i', true, 'btree']],
  );
});

for (const body of [
  `Table parent { id int [pk] }\nTable child { pid int }\nRef: child.pid > parent.id`,
  `Table parent { id int [pk] }\nTable child { pid int }\nRef: parent.id < child.pid`,
  `Table parent as p { id int [pk] }\nTable child { pid int [ref: > p.id] }`,
]) {
  test(`DBML physical reference direction: ${body.split('\n').at(-1)}`, () => {
    const result = schema(body);
    assert.equal(result.tables[0]?.foreignKeys.length, 0);
    const fk = result.tables[1]?.foreignKeys[0];
    assert.equal(fk?.target.name, 'parent');
    assert.deepEqual(fk?.columns, ['pid']);
    assert.deepEqual(fk?.targetColumns, ['id']);
    assert.equal(fk?.match, 'simple');
    assert.equal(fk?.deferrable, false);
  });
}

test('DBML standalone one-to-one uses the second endpoint as foreign key', () => {
  const result = schema(`Table p { id int [pk] }\nTable c { pid int [unique] }\nRef: p.id - c.pid`);
  assert.equal(result.tables[1]?.foreignKeys[0]?.target.name, 'p');
  assert.equal(result.tables[1]?.uniqueKeys.length, 1);
});

test('DBML inline one-to-one keeps the declaring column as foreign key', () => {
  const result = schema(`Table p { id int [pk] }\nTable c { pid int [unique, ref: - p.id] }`);
  assert.equal(result.tables[1]?.foreignKeys[0]?.target.name, 'p');
});

test('DBML self-reference and composite pair order preserve actions', () => {
  const t = schema(
    `Table t { a int\n b int\n pa int\n pb int\n indexes { (a,b) [pk] } }\nRef fk: t.(pa,pb) > t.(b,a) [delete: set null, update: cascade]`,
  ).tables[0];
  const fk = t?.foreignKeys[0];
  assert.deepEqual(fk?.columns, ['pa', 'pb']);
  assert.deepEqual(fk?.targetColumns, ['b', 'a']);
  assert.equal(fk?.name, 'fk');
  assert.equal(fk?.onDelete, 'set null');
  assert.equal(fk?.onUpdate, 'cascade');
});

for (const [label, body, code] of [
  ['unknown type', 'Table t { v money }', 'DBML_UNSUPPORTED'],
  ['spaced length', 'Table t { v "varchar (20)" }', 'DBML_UNSUPPORTED'],
  ['long precision form', 'Table t { v "timestamp(3) with time zone" }', 'DBML_UNSUPPORTED'],
  ['array', 'Table t { v "int[]" }', 'DBML_UNSUPPORTED'],
  ['unknown enum', 'Table t { v app.missing }', 'DBML_UNSUPPORTED'],
  ['varchar bound', 'Table t { v varchar(0) }', 'DBML_INVALID'],
  ['precision bound', 'Table t { v numeric(1001,2) }', 'DBML_INVALID'],
  ['time precision', 'Table t { v timestamp(7) }', 'DBML_INVALID'],
  ['increment ambiguity', 'Table t { id int [pk, increment] }', 'DBML_UNSUPPORTED'],
  ['check', 'Table t { v int [check: `v > 0`] }', 'DBML_UNSUPPORTED'],
  ['custom setting', "Table t { v int [custom: 'value'] }", 'DBML_UNSUPPORTED'],
  ['explicit nullable key', 'Table t { v int [pk, null] }', 'DBML_INVALID'],
  ['json key', 'Table t { v json [unique] }', 'DBML_INVALID'],
  ['unnamed index', 'Table t { v int\n indexes { v } }', 'DBML_UNSUPPORTED'],
  ['hash index', "Table t { v int\n indexes { v [type: hash, name: 'i'] } }", 'DBML_UNSUPPORTED'],
  [
    'expression index',
    "Table t { v int\n indexes { `lower(v)` [name: 'i'] } }",
    'DBML_UNSUPPORTED',
  ],
  ['missing table', 'Table t { v int [ref: > missing.id] }', 'DBML_SYNTAX'],
  ['missing column', 'Table t { v int [ref: > t.missing] }', 'DBML_SYNTAX'],
  ['nonunique target', 'Table p { id int }\nTable c { pid int [ref: > p.id] }', 'DBML_INVALID'],
  [
    'one-to-one local uniqueness',
    'Table p { id int [pk] }\nTable c { pid int [ref: - p.id] }',
    'DBML_INVALID',
  ],
  ['foreign type', 'Table p { id uuid [pk] }\nTable c { pid int [ref: > p.id] }', 'DBML_INVALID'],
  [
    'many to many',
    'Table a { id int [pk] }\nTable b { id int [pk] }\nRef: a.id <> b.id',
    'DBML_UNSUPPORTED',
  ],
  [
    'inactive ref',
    'Table a { id int [pk] }\nTable b { id int [pk] }\nRef: a.id > b.id [inactive]',
    'DBML_UNSUPPORTED',
  ],
  ['partial', 'TablePartial common { id int [pk] }\nTable t { ~common }', 'DBML_UNSUPPORTED'],
  ['duplicate table', 'Table t { id int }\nTable t { id int }', 'DBML_SYNTAX'],
  ['duplicate column', 'Table t { id int\n id int }', 'DBML_SYNTAX'],
  ['duplicate enum label', 'Enum e { x\n x }', 'DBML_SYNTAX'],
] as const)
  test(`DBML rejects ${label} without a partial schema`, () => {
    failure(body, code);
  });

test('DBML index namespace collisions fail', () => {
  failure(`Table t { id int\n indexes { id [name: 't'] } }`, 'DBML_INVALID');
});

test('DBML notes and display groups do not become physical schema facts', () => {
  const result = schema(
    `Table t [headercolor: #ff0000] { id int [pk, note: 'description']\n Note: 'table note' }\nTableGroup g { t }\nNote n { 'hello' }`,
  );
  assert.equal(result.tables.length, 1);
  assert.equal(JSON.stringify(result).includes('description'), false);
  assert.equal(JSON.stringify(result).includes('hello'), false);
});

test('DBML requires a declared matching PostgreSQL engine', () => {
  for (const input of [
    'Table t { id int }',
    "Project p { database_type: 'MySQL' }\nTable t { id int }",
  ])
    assert.equal(normalizeDbml(input, options).diagnostics[0]?.code, 'DBML_DIALECT');
});

test('DBML validates options and Unicode before parsing', () => {
  for (const input of [
    null,
    {},
    { target: 'mysql' },
    { target: 'postgres', maxInputBytes: 0 },
    { target: 'postgres', maxInputBytes: 8388609 },
    { target: 'postgres', maxObjects: 0 },
  ])
    assert.equal(normalizeDbml(project, input as DbmlOptions).diagnostics[0]?.code, 'DBML_OPTIONS');
  for (const input of [42, '\0', '\ud800'])
    assert.equal(normalizeDbml(input as string, options).diagnostics[0]?.code, 'DBML_OPTIONS');
});

test('DBML bounds UTF-8 bytes, objects, identifiers and nesting', () => {
  assert.equal(
    normalizeDbml(project, { ...options, maxInputBytes: 4 }).diagnostics[0]?.code,
    'DBML_LIMIT',
  );
  assert.equal(
    normalizeDbml(project + 'Table t { a int\n b int }', { ...options, maxObjects: 2 })
      .diagnostics[0]?.code,
    'DBML_LIMIT',
  );
  failure(`Table "${'é'.repeat(32)}" { id int }`, 'DBML_INVALID');
  schema(`Table "${'a'.repeat(63)}" { id int }`);
  failure(`${'('.repeat(65)}${')'.repeat(65)}`, 'DBML_LIMIT');
});

test('DBML locations use UTF-8 byte offsets and one-based source positions', () => {
  const body = '// é😀\r\nTable t {\r\n  v money\r\n}';
  const d = failure(body, 'DBML_UNSUPPORTED');
  const index = (project + body).indexOf('v money');
  assert.deepEqual(d?.location, {
    offset: Buffer.byteLength((project + body).slice(0, index)),
    line: 4,
    column: 3,
  });
});

test('DBML deterministic outputs, isolation, and failure recovery', () => {
  const body = 'Table t { id int [pk] }';
  const original = schema(body);
  const next = schema(body);
  assert.deepEqual(next, original);
  next.tables[0]?.columns.splice(0);
  assert.equal(original.tables[0]?.columns.length, 1);
  failure('Table t { v money }', 'DBML_UNSUPPORTED');
  assert.deepEqual(schema(body), original);
  assert.equal(normalizeDbml(project, Object.freeze(options)).ok, true);
});

test('DBML syntax errors are structured and located', () => {
  const d = failure('Table t { v }', 'DBML_SYNTAX');
  assert.ok((d?.location.line ?? 0) >= 2);
});

test('DBML enum named json remains comparable and preserves empty labels', () => {
  const result = schema('Enum json { ""\n value }\nTable t { v json [pk] }');
  assert.deepEqual(result.enums[0]?.values, ['', 'value']);
  assert.equal(result.tables[0]?.columns[0]?.type.kind, 'enum');
  assert.deepEqual(result.tables[0]?.primaryKey?.columns, ['v']);
});

for (const type of ['numeric(10)', 'bpchar', 'char', '"double precision"', 'pg_catalog.int4']) {
  test(`DBML type ${type} matches the SQL schema contract`, async () => {
    const dbml = schema(`Table t { v ${type} }`);
    const sql = await normalizePostgres(`CREATE TABLE t (v ${type.replaceAll('"', '')});`, {
      dialect: 'postgres',
      target: 'postgres',
    });
    assert.equal(sql.ok, true);
    if (!sql.ok) return;
    assert.deepEqual(dbml.tables[0]?.columns[0]?.type, sql.schema.tables[0]?.columns[0]?.type);
  });
}

test('DBML empty project succeeds without invented tables', () => {
  assert.deepEqual(schema(''), {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public'],
    tables: [],
    enums: [],
  });
});

test('DBML ignores presentation only and resolves table aliases', () => {
  const result =
    schema(`Table p as parent [note: 'one', headercolor: #FFF] { id int [pk, note: 'x'] }
Table c { p int [ref: > parent.id] }
TableGroup grouping { p\n c\n note: 'comment' }
Note comment { 'a' }`);
  assert.deepEqual(result.tables[1]?.foreignKeys[0]?.target, { schema: 'public', name: 'p' });
  assert.equal(result.tables[0]?.name, 'p');
  assert.equal(result.tables[0]?.columns[0]?.nullable, false);
});

test('DBML retains reference order across standalone and inline declarations', () => {
  const result = schema(`Ref first: t.a > p.id
Table p { id int [pk] }
Table t { a int\n b int [ref: > p.id]\n c int }
Ref last: t.c > p.id`);
  assert.deepEqual(
    result.tables[1]?.foreignKeys.map((key) => [key.name, key.columns]),
    [
      ['first', ['a']],
      [undefined, ['b']],
      ['last', ['c']],
    ],
  );
});

test('DBML unquoted names are not folded and escaped quoted names stay physical', () => {
  const result = schema(`Table MixedCase { Value int }
Table "a\\\"b" { "c\\\"d" text [default: 'a\\\'b'] }`);
  assert.equal(result.tables[0]?.name, 'MixedCase');
  assert.equal(result.tables[0]?.columns[0]?.name, 'Value');
  assert.equal(result.tables[1]?.name, 'a"b');
  assert.equal(result.tables[1]?.columns[0]?.name, 'c"d');
  assert.deepEqual(result.tables[1]?.columns[0]?.default, {
    kind: 'literal',
    type: 'string',
    value: "a'b",
  });
});

for (const [name, source, code] of [
  ['partial', 'TablePartial common { id int }\nTable t { ~common }', 'DBML_UNSUPPORTED'],
  ['records', 'Table t { id int }\nRecords t(id) { 1 }', 'DBML_UNSUPPORTED'],
  [
    'inactive reference',
    'Table p { id int [pk] }\nTable c { p int }\nRef: c.p > p.id [inactive]',
    'DBML_UNSUPPORTED',
  ],
  [
    'project metadata',
    "Project p { database_type: 'PostgreSQL'\n custom: 'value' }\nTable t { id int }",
    'DBML_UNSUPPORTED',
  ],
  ['empty expression', 'Table t { v int [default: ``] }', 'DBML_INVALID'],
  ['multiple primary keys', 'Table t { a int [pk]\n b int\n indexes { b [pk] } }', 'DBML_INVALID'],
  ['composite explicit null', 'Table t { a int [pk, null]\n b int [pk] }', 'DBML_INVALID'],
  ['reserved object type', 'Table t { v constructor }', 'DBML_UNSUPPORTED'],
  ['qualified SQL alias', 'Table t { v pg_catalog.integer }', 'DBML_UNSUPPORTED'],
  ['qualified char', 'Table t { v pg_catalog.char }', 'DBML_UNSUPPORTED'],
  ['oversized enum label', `Enum e { "${'x'.repeat(64)}" }`, 'DBML_INVALID'],
  ['table enum collision', 'Enum e { value }\nTable e { v int }', 'DBML_INVALID'],
  ['index table collision', "Table t { v int\n indexes { v [name: 't'] } }", 'DBML_INVALID'],
] as const) {
  test(`DBML reviewed regression rejects ${name}`, () => {
    const input = source.startsWith('Project') ? source : project + source;
    const result = normalizeDbml(input, options);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics[0]?.code, code, JSON.stringify(result));
    assert.ok(result.diagnostics[0]?.message.length);
    assert.equal('schema' in result, false);
  });
}
