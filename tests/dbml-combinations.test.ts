import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReferentialAction } from '../src/schema/model.js';
import { expectFailure, expectSchema, physical, project } from './dbml-test-helpers.js';

const actions: ReferentialAction[] = [
  'no action',
  'restrict',
  'cascade',
  'set null',
  'set default',
];
for (const onDelete of actions) {
  for (const onUpdate of actions) {
    test(`DBML composite circular cross-schema reference delete=${onDelete} update=${onUpdate}`, () => {
      const schema = expectSchema(
        project +
          `
        Ref forward: right.children.(parent_a, parent_b) > left.parents.(a, b) [delete: ${onDelete}, update: ${onUpdate}]
        Ref backward: left.parents.child_id > right.children.id
        Table left.parents {
          a int [pk]
          b int [pk]
          child_id int
        }
        Table right.children {
          id int [pk]
          parent_a bigint [default: 0]
          parent_b smallint [default: 0]
        }
      `,
      );
      assert.deepEqual(schema.namespaces, ['public', 'left', 'right']);
      const [parent, child] = schema.tables;
      assert.ok(parent && child);
      assert.deepEqual(physical(parent.primaryKey), { columns: ['a', 'b'] });
      assert.deepEqual(
        child.columns.map((column) => column.nullable),
        [false, true, true],
      );
      assert.deepEqual(physical(child.foreignKeys), [
        {
          name: 'forward',
          columns: ['parent_a', 'parent_b'],
          target: { schema: 'left', name: 'parents' },
          targetColumns: ['a', 'b'],
          onDelete,
          onUpdate,
          match: 'simple',
          deferrable: false,
          initiallyDeferred: false,
        },
      ]);
      assert.deepEqual(physical(parent.foreignKeys), [
        {
          name: 'backward',
          columns: ['child_id'],
          target: { schema: 'right', name: 'children' },
          targetColumns: ['id'],
          onDelete: 'no action',
          onUpdate: 'no action',
          match: 'simple',
          deferrable: false,
          initiallyDeferred: false,
        },
      ]);
    });
  }
}

const families = [
  ['smallint', 'integer', 'bigint'],
  ['text', 'varchar(32)'],
];
for (const family of families) {
  for (const local of family) {
    for (const target of family) {
      test(`DBML foreign-key compatibility ${local} -> ${target}`, () => {
        const schema = expectSchema(
          project +
            `Table p { id ${target} [pk] }
          Table c { value ${local} }
          Ref relation: c.value > p.id`,
        );
        assert.deepEqual(physical(schema.tables[1]?.foreignKeys), [
          {
            name: 'relation',
            columns: ['value'],
            target: { schema: 'public', name: 'p' },
            targetColumns: ['id'],
            onDelete: 'no action',
            onUpdate: 'no action',
            match: 'simple',
            deferrable: false,
            initiallyDeferred: false,
          },
        ]);
      });
    }
  }
}

for (const type of [
  'boolean',
  'uuid',
  'jsonb',
  'numeric(12,2)',
  'char(2)',
  'real',
  '"double precision"',
  'bytea',
  'date',
  'time(3)',
  'timetz(6)',
  'timestamp(3)',
  'timestamptz(6)',
]) {
  test(`DBML identical foreign-key type ${type}`, () => {
    const schema = expectSchema(
      project +
        `Table p { id ${type} [pk] }
      Table c { value ${type} }
      Ref: c.value > p.id`,
    );
    assert.deepEqual(schema.tables[1]?.foreignKeys[0]?.targetColumns, ['id']);
    assert.deepEqual(
      physical(schema.tables[0]?.columns[0]?.type),
      physical(schema.tables[1]?.columns[0]?.type),
    );
  });
}

for (const [local, target] of [
  ['text', 'uuid'],
  ['integer', 'numeric'],
  ['timestamp', 'timestamptz'],
  ['char(2)', 'varchar(2)'],
  ['time', 'timetz'],
  ['jsonb', 'text'],
]) {
  test(`DBML rejects incompatible foreign-key type ${local} -> ${target}`, () => {
    expectFailure(
      project +
        `Table p { id ${target} [pk] }
      Table c { value ${local} }
      Ref: c.value > p.id`,
      'DBML_INVALID',
    );
  });
}

test('DBML enum reference compatibility requires the same qualified enum, not identical labels', () => {
  const body = `Enum first.state { ready }
    Enum second.state { ready }
    Table p { id first.state [pk] }
    Table c { value second.state }`;
  expectFailure(project + body + '\nRef: c.value > p.id', 'DBML_INVALID');
  const schema = expectSchema(
    project + body.replace('value second.state', 'value first.state') + '\nRef: c.value > p.id',
  );
  assert.deepEqual(schema.tables[1]?.foreignKeys[0]?.targetColumns, ['id']);
});

// Catalog names are independent expectations, not computed from the adapter's alias table.
for (const [source, name, modifiers] of [
  ['int', 'int4', []],
  ['integer', 'int4', []],
  ['int4', 'int4', []],
  ['smallint', 'int2', []],
  ['int2', 'int2', []],
  ['bigint', 'int8', []],
  ['int8', 'int8', []],
  ['boolean', 'bool', []],
  ['bool', 'bool', []],
  ['text', 'text', []],
  ['varchar', 'varchar', []],
  ['character varying', 'varchar', []],
  ['char', 'bpchar', [1]],
  ['character', 'bpchar', [1]],
  ['bpchar', 'bpchar', []],
  ['decimal', 'numeric', []],
  ['numeric', 'numeric', []],
  ['uuid', 'uuid', []],
  ['json', 'json', []],
  ['jsonb', 'jsonb', []],
  ['date', 'date', []],
  ['timestamp', 'timestamp', []],
  ['timestamp without time zone', 'timestamp', []],
  ['timestamp with time zone', 'timestamptz', []],
  ['timestamptz', 'timestamptz', []],
  ['time', 'time', []],
  ['time without time zone', 'time', []],
  ['time with time zone', 'timetz', []],
  ['timetz', 'timetz', []],
  ['real', 'float4', []],
  ['float4', 'float4', []],
  ['double precision', 'float8', []],
  ['float8', 'float8', []],
  ['bytea', 'bytea', []],
] as const) {
  test(`DBML scalar spelling ${source} has independently specified catalog facts`, () => {
    for (const spelling of [source, source.toUpperCase()]) {
      const schema = expectSchema(project + `Table t { value "${spelling}" }`);
      assert.deepEqual(physical(schema.tables[0]?.columns[0]?.type), {
        kind: 'builtin',
        schema: 'pg_catalog',
        name,
        modifiers: [...modifiers],
      });
    }
  });
}

for (const [type, name, modifiers] of [
  ['varchar(1)', 'varchar', [1]],
  ['varchar(10485760)', 'varchar', [10485760]],
  ['char(1)', 'bpchar', [1]],
  ['char(10485760)', 'bpchar', [10485760]],
  ['numeric(1)', 'numeric', [1]],
  ['numeric(1000)', 'numeric', [1000]],
  ['numeric(1,-1000)', 'numeric', [1, -1000]],
  ['numeric(1,1000)', 'numeric', [1, 1000]],
  ['time(0)', 'time', [0]],
  ['time(6)', 'time', [6]],
  ['timetz(0)', 'timetz', [0]],
  ['timetz(6)', 'timetz', [6]],
  ['timestamp(0)', 'timestamp', [0]],
  ['timestamp(6)', 'timestamp', [6]],
  ['timestamptz(0)', 'timestamptz', [0]],
  ['timestamptz(6)', 'timestamptz', [6]],
] as const) {
  test(`DBML type modifier accepted boundary ${type}`, () => {
    const schema = expectSchema(project + `Table t { value ${type} }`);
    assert.deepEqual(physical(schema.tables[0]?.columns[0]?.type), {
      kind: 'builtin',
      schema: 'pg_catalog',
      name,
      modifiers: [...modifiers],
    });
  });
}

for (const type of [
  'varchar(0)',
  'varchar(10485761)',
  'char(0)',
  'char(10485761)',
  'numeric(0)',
  'numeric(1001)',
  'numeric(1,-1001)',
  'numeric(1,1001)',
  'time(-1)',
  'time(7)',
  'timetz(-1)',
  'timetz(7)',
  'timestamp(-1)',
  'timestamp(7)',
  'timestamptz(-1)',
  'timestamptz(7)',
]) {
  test(`DBML type modifier rejected boundary ${type}`, () => {
    expectFailure(project + `Table t { value ${type} }`, 'DBML_INVALID');
  });
}
