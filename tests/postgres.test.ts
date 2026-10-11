import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizePostgres } from '../src/adapters/postgres.js';
import type { PostgresOptions, SchemaDocument } from '../src/schema/model.js';

const options = { dialect: 'postgres', target: 'postgres' } as const;
async function normalize(sql: string): Promise<SchemaDocument> {
  const result = await normalizePostgres(sql, options);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('Expected a schema');
  return result.schema;
}
async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../../tests/fixtures/pairs/${name}.sql`, import.meta.url), 'utf8');
}
async function rejected(sql: string, code: string): Promise<void> {
  const result = await normalizePostgres(sql, options);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected rejection');
  assert.equal('schema' in result, false, 'Invalid input must never expose a partial schema');
  assert.equal(result.diagnostics[0]?.code, code, JSON.stringify(result));
  assert.equal(result.diagnostics[0]?.severity, 'error');
  assert.ok(result.diagnostics[0]?.message);
}

test('normalization preserves independently specified basic column, key and default facts', async () => {
  const schema = await normalize(await fixture('basic'));
  assert.equal(schema.version, 1);
  assert.equal(schema.dialect, 'postgres');
  assert.deepEqual(schema.namespaces, ['public']);
  const table = schema.tables[0];
  assert.ok(table);
  assert.deepEqual([table.schema, table.name], ['public', 'accounts']);
  assert.deepEqual(
    table.columns.map((c) => c.name),
    ['id', 'email', 'enabled', 'balance', 'nickname', 'created_at'],
  );
  assert.deepEqual(
    table.columns.map((c) => c.nullable),
    [false, false, true, false, true, true],
  );
  assert.deepEqual(table.primaryKey?.columns, ['id']);
  assert.deepEqual(
    table.uniqueKeys.map((k) => k.columns),
    [['email']],
  );
  assert.deepEqual(table.columns[1]?.type, {
    kind: 'builtin',
    schema: 'pg_catalog',
    name: 'varchar',
    modifiers: [255],
  });
  assert.deepEqual(table.columns[3]?.type.modifiers, [12, 2]);
  assert.deepEqual(table.columns[2]?.default, { kind: 'literal', type: 'boolean', value: true });
  assert.deepEqual(table.columns[3]?.default, { kind: 'literal', type: 'number', value: '0' });
  assert.deepEqual(table.columns[5]?.default, { kind: 'expression', sql: 'now()' });
});

test('composite keys, enum labels, FK ordering and database actions remain distinct', async () => {
  const schema = await normalize(await fixture('tenant'));
  assert.deepEqual(schema.namespaces, ['public', 'tenant']);
  assert.deepEqual(schema.enums[0]?.values, ['pending', 'complete', "customer's hold"]);
  const orders = schema.tables[1];
  assert.ok(orders);
  assert.deepEqual(orders.primaryKey?.columns, ['tenant_id', 'id']);
  assert.deepEqual(orders.uniqueKeys[0]?.columns, ['tenant_id', 'order_code']);
  const fk = orders.foreignKeys[0];
  assert.ok(fk);
  assert.deepEqual(fk.columns, ['tenant_id', 'account_id']);
  assert.deepEqual(fk.targetColumns, ['tenant_id', 'id']);
  assert.deepEqual(fk.target, { schema: 'tenant', name: 'accounts' });
  assert.equal(fk.onDelete, 'no action');
  assert.equal(fk.onUpdate, 'cascade');
  assert.equal(fk.deferrable, false);
  assert.equal('cascade' in fk, false, 'Database actions must not imply persistence cascades');
  assert.equal(orders.columns[4]?.type.kind, 'enum');
});

test('quoted physical identifiers, nullable self-reference and named indexes are preserved', async () => {
  const schema = await normalize(await fixture('quoted'));
  const table = schema.tables[0];
  assert.ok(table);
  assert.equal(table.schema, 'Sales Team');
  assert.equal(table.name, 'Member Record');
  assert.equal(table.columns[1]?.nullable, true);
  assert.deepEqual(table.foreignKeys[0]?.targetColumns, ['Member Id']);
  assert.equal(table.indexes[0]?.name, 'Member Manager Index');
  assert.equal(table.indexes[0]?.method, 'btree');
  assert.deepEqual(table.indexes[0]?.columns, ['Manager Id']);
});

test('literal defaults preserve false, null, escaping, signs, precision and large numeric lexemes', async () => {
  const schema = await normalize(`CREATE TABLE literals (
    a boolean DEFAULT false, b text DEFAULT 'false', c text DEFAULT NULL,
    d text DEFAULT 'can''t', e numeric DEFAULT -12.300,
    f numeric DEFAULT 99999999999999999999999, g int DEFAULT 0,
    h text DEFAULT '', i numeric DEFAULT 1e100
  );`);
  assert.deepEqual(
    schema.tables[0]?.columns.map((c) => c.default),
    [
      { kind: 'literal', type: 'boolean', value: false },
      { kind: 'literal', type: 'string', value: 'false' },
      { kind: 'literal', type: 'null', value: null },
      { kind: 'literal', type: 'string', value: "can't" },
      { kind: 'literal', type: 'number', value: '-12.300' },
      { kind: 'literal', type: 'number', value: '99999999999999999999999' },
      { kind: 'literal', type: 'number', value: '0' },
      { kind: 'literal', type: 'string', value: '' },
      { kind: 'literal', type: 'number', value: '1e100' },
    ],
  );
});

test('identity and expression defaults remain separate from literals', async () => {
  const schema = await normalize(`CREATE TABLE expressions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    other int GENERATED BY DEFAULT AS IDENTITY,
    state text DEFAULT 'é'::text,
    created timestamptz DEFAULT CURRENT_TIMESTAMP(3),
    token uuid DEFAULT pg_catalog.gen_random_uuid()
  );`);
  const cols = schema.tables[0]?.columns;
  assert.deepEqual(cols?.[0]?.generation, { kind: 'identity', strategy: 'always' });
  assert.deepEqual(cols?.[1]?.generation, { kind: 'identity', strategy: 'by-default' });
  assert.equal(cols?.[1]?.nullable, false);
  assert.deepEqual(cols?.[2]?.default, { kind: 'expression', sql: "'é'::text" });
  assert.deepEqual(cols?.[3]?.default, { kind: 'expression', sql: 'CURRENT_TIMESTAMP(3)' });
  assert.deepEqual(cols?.[4]?.default, { kind: 'expression', sql: 'pg_catalog.gen_random_uuid()' });
});

test('ordered ALTER additions permit cyclic FKs and apply column mutations', async () => {
  const schema = await normalize(`CREATE TABLE a (id int PRIMARY KEY);
    CREATE TABLE b (id int PRIMARY KEY, a_id int);
    ALTER TABLE a ADD COLUMN b_id int DEFAULT 0, ADD CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b;
    ALTER TABLE b ADD CONSTRAINT b_a FOREIGN KEY(a_id) REFERENCES a(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE a ALTER COLUMN b_id SET DEFAULT (42), ALTER COLUMN b_id SET NOT NULL;
    ALTER TABLE a ALTER COLUMN b_id DROP DEFAULT, ALTER COLUMN b_id DROP NOT NULL;
  `);
  assert.equal(schema.tables[0]?.columns[1]?.default, undefined);
  assert.equal(schema.tables[0]?.columns[1]?.nullable, true);
  assert.deepEqual(schema.tables[0]?.foreignKeys[0]?.targetColumns, ['id']);
  assert.equal(schema.tables[1]?.foreignKeys[0]?.deferrable, true);
  assert.equal(schema.tables[1]?.foreignKeys[0]?.initiallyDeferred, true);
  assert.equal(schema.tables[1]?.foreignKeys[0]?.onDelete, 'set null');
});

test('unique btree indexes can back FKs, without inferring relations from column names', async () => {
  const schema = await normalize(`CREATE TABLE target (x int, y int);
    CREATE UNIQUE INDEX target_key ON target(x,y);
    CREATE TABLE source (id int PRIMARY KEY, x int, y int, account_id int,
      FOREIGN KEY (y,x) REFERENCES target(y,x) MATCH FULL ON DELETE RESTRICT ON UPDATE SET DEFAULT);
  `);
  assert.equal(schema.tables[0]?.indexes[0]?.unique, true);
  assert.equal(schema.tables[1]?.foreignKeys.length, 1);
  assert.equal(schema.tables[1]?.foreignKeys[0]?.match, 'full');
});

for (const [name, sql] of Object.entries({
  dml: 'INSERT INTO a VALUES (1);',
  execution: 'SELECT pg_sleep(10);',
  searchPath: 'SET search_path = tenant;',
  check: 'CREATE TABLE a (id int CHECK (id > 0));',
  generated: 'CREATE TABLE a (id int, x int GENERATED ALWAYS AS (id+1) STORED);',
  array: 'CREATE TABLE a (id int[]);',
  serial: 'CREATE TABLE a (id serial);',
  customType: 'CREATE TABLE a (id geometry);',
  domain: 'CREATE DOMAIN positive AS int CHECK(VALUE>0);',
  partition: 'CREATE TABLE a (id int) PARTITION BY HASH(id);',
  temporary: 'CREATE TEMP TABLE a (id int);',
  unlogged: 'CREATE UNLOGGED TABLE a (id int);',
  inherits: 'CREATE TABLE a (id int); CREATE TABLE b () INHERITS (a);',
  conditional: 'CREATE TABLE IF NOT EXISTS a (id int);',
  collation: 'CREATE TABLE a (id text COLLATE "C");',
  deferredUnique: 'CREATE TABLE a (id int UNIQUE DEFERRABLE);',
  identityOptions: 'CREATE TABLE a (id int GENERATED ALWAYS AS IDENTITY (START WITH 20));',
  partialIndex: 'CREATE TABLE a (id int); CREATE INDEX i ON a(id) WHERE id > 0;',
  expressionIndex: 'CREATE TABLE a (id text); CREATE INDEX i ON a(lower(id));',
  indexSort: 'CREATE TABLE a (id int); CREATE INDEX i ON a(id DESC);',
  indexInclude: 'CREATE TABLE a (id int, x int); CREATE INDEX i ON a(id) INCLUDE(x);',
  indexMethod: 'CREATE TABLE a (id text); CREATE INDEX i ON a USING hash(id);',
  nullsDistinct: 'CREATE TABLE a (id int UNIQUE NULLS NOT DISTINCT);',
  notValid:
    'CREATE TABLE a (id int PRIMARY KEY); ALTER TABLE a ADD CONSTRAINT f FOREIGN KEY(id) REFERENCES a NOT VALID;',
  drop: 'CREATE TABLE a (id int); DROP TABLE a;',
  rename: 'CREATE TABLE a (id int); ALTER TABLE a RENAME TO b;',
  alterType: 'CREATE TABLE a (id int); ALTER TABLE a ALTER COLUMN id TYPE bigint;',
  functionDefault: 'CREATE TABLE a (id int DEFAULT arbitrary_function());',
  expressionDefault: 'CREATE TABLE a (id int DEFAULT 1+2);',
  longIdentifier: `CREATE TABLE "${'x'.repeat(64)}"(id int);`,
})) {
  test(`unsupported ${name} is diagnosed instead of silently normalized`, async () =>
    rejected(sql, 'SQL_UNSUPPORTED'));
}

for (const [name, sql] of Object.entries({
  duplicateTable: 'CREATE TABLE a(id int); CREATE TABLE a(id int);',
  duplicateColumn: 'CREATE TABLE a(id int, id text);',
  duplicateEnum: "CREATE TYPE state AS ENUM ('a', 'a');",
  sharedTypeNamespace: "CREATE TABLE a(id int); CREATE TYPE a AS ENUM ('x');",
  duplicateConstraint: 'CREATE TABLE a(id int CONSTRAINT u UNIQUE, x int CONSTRAINT u UNIQUE);',
  namespace: 'CREATE TABLE missing.a(id int);',
  missingLocal: 'CREATE TABLE a(id int, PRIMARY KEY(missing));',
  missingTarget: 'CREATE TABLE a(id int REFERENCES missing(id));',
  forwardReference: 'CREATE TABLE a(id int REFERENCES b(id)); CREATE TABLE b(id int PRIMARY KEY);',
  noCandidateKey: 'CREATE TABLE a(id int); CREATE TABLE b(id int REFERENCES a(id));',
  missingTargetColumn:
    'CREATE TABLE a(id int PRIMARY KEY); CREATE TABLE b(id int REFERENCES a(missing));',
  wrongArity:
    'CREATE TABLE a(id int PRIMARY KEY); CREATE TABLE b(id int, x int, FOREIGN KEY(id,x) REFERENCES a(id));',
  duplicateKeyColumn: 'CREATE TABLE a(id int, PRIMARY KEY(id,id));',
  nullablePrimaryKey: 'CREATE TABLE a(id int NULL PRIMARY KEY);',
  primaryKeyDropNull:
    'CREATE TABLE a(id int PRIMARY KEY); ALTER TABLE a ALTER COLUMN id DROP NOT NULL;',
  incompatibleFk: 'CREATE TABLE a(id uuid PRIMARY KEY); CREATE TABLE b(id int REFERENCES a(id));',
  unknownMutationColumn: 'CREATE TABLE a(id int); ALTER TABLE a ALTER COLUMN missing SET NOT NULL;',
  duplicateDefault: 'CREATE TABLE a(id int DEFAULT 1 DEFAULT 2);',
  duplicateGeneration: 'CREATE TABLE a(id int GENERATED ALWAYS AS IDENTITY DEFAULT 1);',
  identityType: 'CREATE TABLE a(id text GENERATED ALWAYS AS IDENTITY);',
  indexCollision: 'CREATE TABLE a(id int); CREATE INDEX a ON a(id);',
  uniqueIndexCollision:
    'CREATE TABLE a(id int CONSTRAINT u UNIQUE); CREATE TABLE b(id int); CREATE INDEX u ON b(id);',
  numericPrecision: 'CREATE TABLE a(id numeric(0,2));',
  characterLength: 'CREATE TABLE a(id varchar(0));',
  timePrecision: 'CREATE TABLE a(id timestamp(7));',
})) {
  test(`invalid ${name} cannot produce a successful schema`, async () =>
    rejected(sql, 'SCHEMA_INVALID'));
}

test('configuration, syntax and resource diagnostics are explicit and deterministic', async () => {
  await rejected('CREATE TABLE broken (', 'SQL_PARSE');
  const mismatch = await normalizePostgres('CREATE TABLE a(id int)', {
    dialect: 'postgres',
    target: 'mysql',
  } as unknown as PostgresOptions);
  assert.equal(mismatch.diagnostics[0]?.code, 'SQL_DIALECT');
  const limited = await normalizePostgres('CREATE TABLE a(id int)', {
    ...options,
    maxInputBytes: 4,
  });
  assert.equal(limited.diagnostics[0]?.code, 'SQL_LIMIT');
  const objects = await normalizePostgres('CREATE TABLE a(id int, x int)', {
    ...options,
    maxObjects: 2,
  });
  assert.equal(objects.diagnostics[0]?.code, 'SQL_LIMIT');
  const invalidLimit = await normalizePostgres('', { ...options, maxObjects: -1 });
  assert.equal(invalidLimit.diagnostics[0]?.code, 'SQL_OPTIONS');
  const sql = 'CREATE TABLE "é"(id int);\nCREATE TABLE b(id int[]);';
  const first = await normalizePostgres(sql, options);
  const again = await normalizePostgres(sql, options);
  assert.deepEqual(first, again);
  assert.equal(first.diagnostics[0]?.location.line, 2);
  assert.ok(
    (first.diagnostics[0]?.location.offset ?? 0) >=
      Buffer.byteLength('CREATE TABLE "é"(id int);\n'),
  );
  assert.deepEqual(first.diagnostics[0]?.object, { schema: 'public', name: 'b' });
});

test('normalization has no shared schema state across concurrent or failed calls', async () => {
  const sql = await fixture('basic');
  const results = await Promise.all([
    normalize(sql),
    normalize(sql),
    normalize('CREATE TABLE other(x int)'),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[2]?.tables.length, 1);
  await rejected('CREATE TABLE a(x int[]);', 'SQL_UNSUPPORTED');
  assert.deepEqual(await normalize(sql), results[0]);
  assert.deepEqual((await normalize('-- empty schema')).tables, []);
});

test('explicit NULL applies within a column definition, not to later ALTER constraints', async () => {
  const schema = await normalize(`CREATE TABLE a(id int NULL);
    ALTER TABLE a ADD CONSTRAINT pk PRIMARY KEY(id);
    ALTER TABLE a ADD COLUMN other int NULL;
    ALTER TABLE a ALTER COLUMN other SET NOT NULL;
    ALTER TABLE a ADD CONSTRAINT u UNIQUE(other);`);
  assert.equal(schema.tables[0]?.columns[0]?.nullable, false);
  assert.equal(schema.tables[0]?.columns[1]?.nullable, false);
});

test('embedded NUL and malformed Unicode cannot silently truncate or replace SQL input', async () => {
  await rejected('CREATE TABLE a(id int);\0DROP TABLE a;', 'SQL_OPTIONS');
  await rejected('CREATE TABLE "\ud800"(id int);', 'SQL_OPTIONS');
});

test('Unicode escape identifiers are rejected until decoding and byte-length checks are supported', async () => {
  await rejected('CREATE TABLE U&"d\\0061t"(id int);', 'SQL_UNSUPPORTED');
});

test('scanner-based expression boundaries survive nested casts, punctuation and comments', async () => {
  const schema = await normalize(`CREATE TABLE "é" (
    state text DEFAULT (('comma, semi; )'::text)),
    created timestamp DEFAULT now(/* a harmless default comment */) NOT NULL,
    token uuid DEFAULT gen_random_uuid(), value text DEFAULT NULL::text
  );`);
  assert.deepEqual(
    schema.tables[0]?.columns.map((c) => c.default),
    [
      { kind: 'expression', sql: "(('comma, semi; )'::text))" },
      { kind: 'expression', sql: 'now(/* a harmless default comment */)' },
      { kind: 'expression', sql: 'gen_random_uuid()' },
      { kind: 'expression', sql: 'NULL::text' },
    ],
  );
});

test('depth limits reject adversarial nesting before grammar parsing', async () => {
  const result = await normalizePostgres(
    `CREATE TABLE a(id int DEFAULT ${'('.repeat(65)}0${')'.repeat(65)});`,
    options,
  );
  assert.equal(result.diagnostics[0]?.code, 'SQL_LIMIT');
});

test('qualified same-name tables stay distinct and all builtin aliases normalize consistently', async () => {
  const schema = await normalize(`CREATE SCHEMA other;
    CREATE TABLE a (a smallint, b integer, c bigint, d boolean, e real,
      f double precision, g character(2), h character varying(9), i decimal(7,3),
      j timestamp with time zone, k time without time zone, l bytea, m date,
      n json, o jsonb, p uuid);
    CREATE TABLE other.a (id int);`);
  assert.equal(schema.tables.length, 2);
  assert.deepEqual(
    schema.tables[0]?.columns.map((c) => c.type.name),
    [
      'int2',
      'int4',
      'int8',
      'bool',
      'float4',
      'float8',
      'bpchar',
      'varchar',
      'numeric',
      'timestamptz',
      'time',
      'bytea',
      'date',
      'json',
      'jsonb',
      'uuid',
    ],
  );
});

test('diagnostic positions use UTF-8 byte offsets and Unicode character columns', async () => {
  const sql = '-- é\nCREATE TABLE a(id int);\nALTER TABLE a ALTER COLUMN missing SET NOT NULL;';
  const result = await normalizePostgres(sql, options);
  assert.equal(result.diagnostics[0]?.location.line, 3);
  assert.equal(result.diagnostics[0]?.object?.name, 'a');
});

test('json columns cannot form btree keys while jsonb remains usable', async () => {
  await rejected('CREATE TABLE a(id json PRIMARY KEY);', 'SCHEMA_INVALID');
  await rejected('CREATE TABLE a(id json UNIQUE);', 'SCHEMA_INVALID');
  await rejected('CREATE TABLE a(id json); CREATE INDEX i ON a(id);', 'SCHEMA_INVALID');
  const schema = await normalize('CREATE TABLE a(id jsonb PRIMARY KEY);');
  assert.deepEqual(schema.tables[0]?.primaryKey?.columns, ['id']);
});
