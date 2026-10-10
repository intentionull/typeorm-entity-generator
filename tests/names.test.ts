import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizePostgres } from '../src/adapters/postgres.js';
import { resolveNames } from '../src/resolve/names.js';
import type { NamingOptions, ResolvedSchema } from '../src/resolve/model.js';
import type { SchemaDocument } from '../src/schema/model.js';

async function schema(sql: string): Promise<SchemaDocument> {
  const result = await normalizePostgres(sql, { dialect: 'postgres', target: 'postgres' });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('Expected normalized schema');
  return result.schema;
}

function resolved(document: SchemaDocument, options?: NamingOptions): ResolvedSchema {
  const result = resolveNames(document, options);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  if (!result.ok) throw new Error('Expected resolved names');
  assert.deepEqual(result.diagnostics, []);
  return result.resolved;
}

function rejected(document: SchemaDocument, code: string, options?: NamingOptions) {
  const result = resolveNames(document, options);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected naming rejection');
  assert.equal('resolved' in result, false, 'A failure must never expose partial names');
  assert.equal(result.diagnostics[0]?.code, code, JSON.stringify(result));
  assert.ok(result.diagnostics.length > 0);
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.severity, 'error');
    assert.ok(diagnostic.message);
    assert.ok(diagnostic.location.line >= 1);
  }
  return result.diagnostics;
}

const accounts = { schema: 'public', name: 'accounts' };

test('defaults preserve plural names and resolve entity, property and file names', async () => {
  const document = await schema(
    'CREATE TABLE accounts(id int PRIMARY KEY, created_at text, user_id int);',
  );
  const result = resolved(document);
  assert.deepEqual(result.entities, [
    {
      table: accounts,
      className: 'Accounts',
      fileName: 'accounts.entity.ts',
      columns: [
        { columnName: 'id', propertyName: 'id' },
        { columnName: 'created_at', propertyName: 'createdAt' },
        { columnName: 'user_id', propertyName: 'userId' },
      ],
    },
  ]);
  assert.deepEqual(result.schema, document);
  assert.deepEqual(result.schema.tables[0]?.foreignKeys, [], 'Names must not invent references');
});

test('quoted, acronym and camel-case names have explicit stable conversion rules', async () => {
  const document = await schema(`CREATE SCHEMA "Sales Team";
    CREATE TABLE "Sales Team"."API Accounts"("Member Id" int, "HTTPStatus" text, "createdAt" text);`);
  const result = resolved(document);
  assert.deepEqual(result.entities, [
    {
      table: { schema: 'Sales Team', name: 'API Accounts' },
      className: 'ApiAccounts',
      fileName: 'api-accounts.entity.ts',
      columns: [
        { columnName: 'Member Id', propertyName: 'memberId' },
        { columnName: 'HTTPStatus', propertyName: 'httpStatus' },
        { columnName: 'createdAt', propertyName: 'createdAt' },
      ],
    },
  ]);
  assert.deepEqual(result.schema, document);
});

test('typed overrides change generated names but preserve all physical schema facts', async () => {
  const document =
    await schema(`CREATE TABLE accounts(id int PRIMARY KEY, parent_id int REFERENCES accounts,
    status text DEFAULT 'pending'); CREATE INDEX status_idx ON accounts(status);`);
  const result = resolved(document, {
    tables: [
      {
        table: accounts,
        className: 'AccountRecord',
        fileName: 'account-records.entity.ts',
        columns: [{ column: 'parent_id', propertyName: 'parentKey' }],
      },
    ],
  });
  assert.deepEqual(result.schema, document);
  assert.equal(result.entities[0]?.className, 'AccountRecord');
  assert.equal(result.entities[0]?.fileName, 'account-records.entity.ts');
  assert.deepEqual(result.entities[0]?.columns[1], {
    columnName: 'parent_id',
    propertyName: 'parentKey',
  });
  assert.deepEqual(result.schema.tables[0]?.foreignKeys[0]?.columns, ['parent_id']);
  assert.deepEqual(result.schema.tables[0]?.primaryKey?.columns, ['id']);
  assert.equal(result.schema.tables[0]?.indexes[0]?.name, 'status_idx');
});

test('class overrides also determine the default filename', async () => {
  const result = resolved(await schema('CREATE TABLE accounts(id int);'), {
    tables: [{ table: accounts, className: 'AccountRecord' }],
  });
  assert.equal(result.entities[0]?.fileName, 'account-record.entity.ts');
});

test('cross-schema collisions require explicit overrides, not inferred prefixes', async () => {
  const document = await schema(
    'CREATE TABLE accounts(id int); CREATE SCHEMA audit; CREATE TABLE audit.accounts(id int);',
  );
  const diagnostics = rejected(document, 'NAME_COLLISION');
  assert.deepEqual(diagnostics[0]?.object, { schema: 'audit', name: 'accounts' });
  const result = resolved(document, {
    tables: [
      {
        table: { schema: 'audit', name: 'accounts' },
        className: 'AuditAccounts',
      },
    ],
  });
  assert.deepEqual(
    result.entities.map((entity) => entity.className),
    ['Accounts', 'AuditAccounts'],
  );
});

test('normalized class collisions still fail when filenames are explicitly distinct', async () => {
  const document = await schema('CREATE TABLE foo_bar(id int); CREATE TABLE "foo-bar"(id int);');
  const diagnostics = rejected(document, 'NAME_COLLISION', {
    tables: [
      { table: { schema: 'public', name: 'foo_bar' }, fileName: 'first.entity.ts' },
      { table: { schema: 'public', name: 'foo-bar' }, fileName: 'second.entity.ts' },
    ],
  });
  assert.match(diagnostics[0]?.message ?? '', /class/i);
});

test('portable filename collisions are case insensitive even with distinct class names', async () => {
  const document = await schema(
    'CREATE TABLE first_table(id int); CREATE TABLE second_table(id int);',
  );
  const diagnostics = rejected(document, 'NAME_COLLISION', {
    tables: [
      { table: { schema: 'public', name: 'first_table' }, fileName: 'Shared.entity.ts' },
      { table: { schema: 'public', name: 'second_table' }, fileName: 'shared.entity.ts' },
    ],
  });
  assert.match(diagnostics[0]?.message ?? '', /file/i);
});

test('column collisions are local to a table and can be repaired explicitly', async () => {
  const document = await schema(
    'CREATE TABLE accounts(user_id int, "user-id" int); CREATE TABLE logs(user_id int);',
  );
  rejected(document, 'NAME_COLLISION');
  const result = resolved(document, {
    tables: [{ table: accounts, columns: [{ column: 'user-id', propertyName: 'externalUserId' }] }],
  });
  assert.deepEqual(
    result.entities[0]?.columns.map((column) => column.propertyName),
    ['userId', 'externalUserId'],
  );
  assert.equal(result.entities[1]?.columns[0]?.propertyName, 'userId');
});

test('overrides themselves cannot create column or class collisions', async () => {
  const document = await schema(
    'CREATE TABLE accounts(id int, code text); CREATE TABLE logs(id int);',
  );
  rejected(document, 'NAME_COLLISION', {
    tables: [{ table: accounts, columns: [{ column: 'code', propertyName: 'id' }] }],
  });
  rejected(document, 'NAME_COLLISION', {
    tables: [
      {
        table: { schema: 'public', name: 'logs' },
        className: 'Accounts',
        fileName: 'logs.entity.ts',
      },
    ],
  });
});

for (const name of [
  'class',
  'await',
  'constructor',
  'prototype',
  '__proto__',
  'a-b',
  '9Column',
  '',
  'é',
  'x\n',
  'x'.repeat(129),
]) {
  test(`unsafe property override ${JSON.stringify(name)} is rejected`, async () => {
    rejected(await schema('CREATE TABLE accounts(id int);'), 'NAME_INVALID', {
      tables: [{ table: accounts, columns: [{ column: 'id', propertyName: name }] }],
    });
  });
}

for (const name of ['class', 'await', '9Record', 'a.b', '', 'Récord', 'A'.repeat(129)]) {
  test(`unsafe class override ${JSON.stringify(name)} is rejected`, async () => {
    rejected(await schema('CREATE TABLE accounts(id int);'), 'NAME_INVALID', {
      tables: [{ table: accounts, className: name }],
    });
  });
}

for (const fileName of [
  '../accounts.entity.ts',
  '/accounts.entity.ts',
  'dir/accounts.entity.ts',
  'dir\\accounts.entity.ts',
  'C:accounts.entity.ts',
  '..entity.ts',
  'x..entity.ts',
  'accounts.ts',
  'accounts.entity.ts ',
  'NUL.entity.ts',
  'com1.entity.ts',
  'lpt9.entity.ts',
  'é.entity.ts',
  'x\0.entity.ts',
  `${'x'.repeat(191)}.entity.ts`,
]) {
  test(`unsafe filename ${JSON.stringify(fileName)} is rejected`, async () => {
    rejected(await schema('CREATE TABLE accounts(id int);'), 'NAME_INVALID', {
      tables: [{ table: accounts, fileName }],
    });
  });
}

test('invalid default names require overrides instead of automatic prefixes or transliteration', async () => {
  const document = await schema('CREATE TABLE "123"("class" int, "é" int);');
  rejected(document, 'NAME_INVALID');
  const result = resolved(document, {
    tables: [
      {
        table: { schema: 'public', name: '123' },
        className: 'NumberedRecords',
        columns: [
          { column: 'class', propertyName: 'classCode' },
          { column: 'é', propertyName: 'accentCode' },
        ],
      },
    ],
  });
  assert.equal(result.entities[0]?.fileName, 'numbered-records.entity.ts');
  assert.deepEqual(result.schema, document);
});

test('qualified selectors are exact and never split dots or fold physical case', async () => {
  const document = await schema(`CREATE SCHEMA "a.b"; CREATE TABLE "a.b"."c.d"("Id" int);
    CREATE SCHEMA a; CREATE TABLE a."b.c.d"(id int);`);
  const result = resolved(document, {
    tables: [
      {
        table: { schema: 'a.b', name: 'c.d' },
        className: 'FirstRecords',
        columns: [{ column: 'Id', propertyName: 'identifier' }],
      },
      { table: { schema: 'a', name: 'b.c.d' }, className: 'SecondRecords' },
    ],
  });
  assert.equal(result.entities[0]?.columns[0]?.propertyName, 'identifier');
  rejected(document, 'NAME_OVERRIDE', {
    tables: [{ table: { schema: 'a.b', name: 'C.D' }, className: 'Other' }],
  });
  rejected(document, 'NAME_OVERRIDE', {
    tables: [
      {
        table: { schema: 'a.b', name: 'c.d' },
        columns: [{ column: 'id', propertyName: 'identifier' }],
      },
    ],
  });
});

test('prototype-like physical selectors are treated as data', async () => {
  const document = await schema(
    'CREATE TABLE "__proto__"("__proto__" int); CREATE TABLE "constructor"(id int);',
  );
  const result = resolved(document, {
    tables: [
      {
        table: { schema: 'public', name: '__proto__' },
        className: 'PrototypeRecords',
        columns: [{ column: '__proto__', propertyName: 'recordKey' }],
      },
      { table: { schema: 'public', name: 'constructor' }, className: 'ConstructorRecords' },
    ],
  });
  assert.equal(result.entities[0]?.columns[0]?.propertyName, 'recordKey');
  assert.equal(result.schema.tables[0]?.name, '__proto__');
});

test('unknown and duplicate override targets fail instead of being ignored', async () => {
  const document = await schema('CREATE TABLE accounts(id int);');
  rejected(document, 'NAME_OVERRIDE', {
    tables: [{ table: { schema: 'public', name: 'missing' }, className: 'Missing' }],
  });
  rejected(document, 'NAME_OVERRIDE', {
    tables: [{ table: accounts, columns: [{ column: 'missing', propertyName: 'missing' }] }],
  });
  rejected(document, 'NAME_OVERRIDE', { tables: [{ table: accounts }, { table: accounts }] });
  rejected(document, 'NAME_OVERRIDE', {
    tables: [
      {
        table: accounts,
        columns: [
          { column: 'id', propertyName: 'first' },
          { column: 'id', propertyName: 'second' },
        ],
      },
    ],
  });
});

for (const value of [
  null,
  [],
  'accounts',
  { tables: null },
  { tables: [null] },
  { tables: [{}] },
  { tables: [{ table: 'public.accounts' }] },
  { tables: [{ table: { schema: 'public' } }] },
  { tables: [{ table: accounts, className: 1 }] },
  { tables: [{ table: accounts, fileName: false }] },
  { tables: [{ table: accounts, columns: {} }] },
  { tables: [{ table: accounts, columns: [{ column: 'id' }] }] },
  { tables: [{ table: accounts, columns: [{ column: 1, propertyName: 'id' }] }] },
  { tables: [{ table: accounts, columns: [{ column: 'id', propertyName: 'key', extra: true }] }] },
  { tables: [{ table: { ...accounts, extra: true } }] },
  { tables: [{ table: accounts, classname: 'Records' }] },
  { singularize: true },
]) {
  test(`malformed declarative options ${JSON.stringify(value)} fail clearly`, async () => {
    rejected(
      await schema('CREATE TABLE accounts(id int);'),
      'NAME_OPTIONS',
      value as NamingOptions,
    );
  });
}

test('source locations identify the conflicting table and column', async () => {
  const document = await schema('CREATE TABLE accounts(id int, user_id int, "user-id" int);');
  const diagnostics = rejected(document, 'NAME_COLLISION');
  assert.deepEqual(diagnostics[0]?.location, document.tables[0]?.columns[2]?.location);
  assert.deepEqual(diagnostics[0]?.object, accounts);
});

test('resolution is deterministic, accepts frozen inputs and shares no mutable output state', async () => {
  const document = await schema('CREATE TABLE accounts(id int); CREATE TABLE logs(id int);');
  const options: NamingOptions = { tables: [{ table: accounts, className: 'AccountRecords' }] };
  const before = structuredClone({ document, options });
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(document);
  freeze(options);
  const first = resolved(document, options);
  assert.deepEqual(resolved(document, options), first);
  assert.deepEqual({ document, options }, before);
  first.schema.tables[0]!.columns[0]!.type.modifiers.push(99);
  first.entities[0]!.table.name = 'changed';
  first.entities[0]!.columns[0]!.propertyName = 'changed';
  assert.deepEqual({ document, options }, before);
  assert.notDeepEqual(resolved(document, options), first);
});

test('override ordering does not change resolved names or source ordering', async () => {
  const document = await schema(
    'CREATE TABLE accounts(id int, code text); CREATE TABLE logs(id int);',
  );
  const entries: NonNullable<NamingOptions['tables']> = [
    {
      table: accounts,
      className: 'AccountRecords',
      columns: [
        { column: 'id', propertyName: 'key' },
        { column: 'code', propertyName: 'label' },
      ],
    },
    { table: { schema: 'public', name: 'logs' }, className: 'LogRecords' },
  ];
  const first = resolved(document, { tables: entries });
  const reversed = structuredClone(entries).reverse();
  reversed[1]!.columns!.reverse();
  assert.deepEqual(resolved(document, { tables: reversed }), first);
  assert.deepEqual(
    first.entities.map((entity) => entity.table.name),
    ['accounts', 'logs'],
  );
});

test('empty schemas and explicit empty options succeed', () => {
  const document: SchemaDocument = {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public'],
    tables: [],
    enums: [],
  };
  assert.deepEqual(resolved(document, { tables: [] }), { schema: document, entities: [] });
});

test('enum and composite-key fixture semantics remain independent of generated names', async () => {
  const document = await schema(await readFile('tests/fixtures/pairs/tenant.sql', 'utf8'));
  const result = resolved(document, {
    tables: [
      {
        table: { schema: 'tenant', name: 'orders' },
        className: 'OrderRecords',
        columns: [{ column: 'account_id', propertyName: 'accountKey' }],
      },
    ],
  });
  assert.deepEqual(result.schema, document);
  assert.equal(result.entities[1]?.columns[2]?.propertyName, 'accountKey');
  assert.deepEqual(result.schema.enums[0]?.values, ['pending', 'complete', "customer's hold"]);
  assert.deepEqual(result.schema.tables[1]?.foreignKeys[0]?.columns, ['tenant_id', 'account_id']);
  assert.deepEqual(result.schema.tables[1]?.foreignKeys[0]?.targetColumns, ['tenant_id', 'id']);
  assert.equal(result.schema.tables[1]?.foreignKeys[0]?.onUpdate, 'cascade');
});

test('identifier and basename length boundaries accept portable explicit names', async () => {
  const result = resolved(await schema('CREATE TABLE accounts(id int);'), {
    tables: [
      {
        table: accounts,
        className: 'X'.repeat(128),
        fileName: `${'x'.repeat(190)}.entity.ts`,
        columns: [{ column: 'id', propertyName: 'x'.repeat(128) }],
      },
    ],
  });
  assert.equal(result.entities[0]?.className.length, 128);
  assert.equal(result.entities[0]?.fileName.length, 200);
  assert.equal(result.entities[0]?.columns[0]?.propertyName.length, 128);
});

test('explicit valid dollar and underscore identifiers need no renaming', async () => {
  const result = resolved(await schema('CREATE TABLE accounts(id int);'), {
    tables: [
      {
        table: accounts,
        className: '$Record',
        fileName: 'record.entity.ts',
        columns: [{ column: 'id', propertyName: '_recordKey' }],
      },
    ],
  });
  assert.equal(result.entities[0]?.className, '$Record');
  assert.equal(result.entities[0]?.columns[0]?.propertyName, '_recordKey');
});

test('diagnostics and failed calls share no mutable state with successful calls', async () => {
  const document = await schema('CREATE TABLE accounts(id int, "class" int);');
  const before = structuredClone(document);
  const first = rejected(document, 'NAME_INVALID');
  assert.deepEqual(rejected(document, 'NAME_INVALID'), first);
  first[0]!.location.line = 999;
  first[0]!.object!.name = 'changed';
  assert.deepEqual(document, before);
  assert.notDeepEqual(rejected(document, 'NAME_INVALID'), first);
  const options: NamingOptions = {
    tables: [{ table: accounts, columns: [{ column: 'class', propertyName: 'classCode' }] }],
  };
  const optionsBefore = structuredClone(options);
  assert.equal(resolved(document, options).entities[0]?.columns[1]?.propertyName, 'classCode');
  assert.deepEqual(options, optionsBefore);
});

test('nondeclarative option objects are rejected rather than silently ignored', async () => {
  const document = await schema('CREATE TABLE accounts(id int);');
  for (const value of [new Date(0), new Map(), () => ({})]) {
    rejected(document, 'NAME_OPTIONS', value as unknown as NamingOptions);
  }
});

test('documented JSON naming overrides resolve the documented names', async () => {
  const guide = await readFile('docs/naming.md', 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(guide)?.[1];
  assert.ok(block, 'The naming guide must contain its declarative override example');
  const options: NamingOptions = JSON.parse(block);
  const document = await schema(
    'CREATE TABLE accounts(id int PRIMARY KEY, parent_id int REFERENCES accounts);',
  );
  const result = resolved(document, options);
  assert.equal(result.entities[0]?.className, 'AccountRecord');
  assert.equal(result.entities[0]?.fileName, 'account-records.entity.ts');
  assert.equal(result.entities[0]?.columns[1]?.propertyName, 'parentKey');
  assert.deepEqual(result.schema, document);
});
