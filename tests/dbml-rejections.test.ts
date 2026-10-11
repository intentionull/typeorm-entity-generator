import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { expectFailure, expectSchema, physical, project } from './dbml-test-helpers.js';

for (const [body, code] of [
  ['Table t { id bigserial }', 'DBML_UNSUPPORTED'],
  ['Table t { id money }', 'DBML_UNSUPPORTED'],
  ['Table t { id custom_domain }', 'DBML_UNSUPPORTED'],
  ["Table t { id int [custom: 'physical'] }", 'DBML_UNSUPPORTED'],
  ["Table t [custom: 'physical'] { id int }", 'DBML_UNSUPPORTED'],
  ['Table t { a int\n b int\n indexes { (a, a) [unique] } }', 'DBML_INVALID'],
  ['Table t { a int\n indexes { missing [unique] } }', 'DBML_SYNTAX'],
  [
    'Table p { id int [pk] }\nTable c { id int }\nRef: c.id > p.id [delete: unknown]',
    'DBML_SYNTAX',
  ],
  ['Table t { id int }\nDependency dep { t.id > t.id }', 'DBML_SYNTAX'],
  ['External outside { Table t { id int } }', 'DBML_SYNTAX'],
  ['Table t { id int }\nRecords t(id) { 1 }', 'DBML_UNSUPPORTED'],
  ['Enum e { repeated\n repeated }', 'DBML_SYNTAX'],
] as const) {
  test(`DBML explicitly rejects ${body}`, () => {
    expectFailure(project + body, code);
  });
}

const retained = ['leading-dot-default', 'multiline-reference-settings'];
test('DBML every retained regression has an explicit expectation', async () => {
  const files = await readdir('tests/fixtures/regressions');
  assert.deepEqual(
    files.filter((file) => file.endsWith('.dbml')).sort(),
    retained.map((name) => `${name}.dbml`).sort(),
  );
});
for (const name of retained) {
  test(`DBML retained parser regression ${name}`, async () => {
    const input = await readFile(`tests/fixtures/regressions/${name}.dbml`, 'utf8');
    expectFailure(input, 'DBML_SYNTAX');
  });
}

test('DBML JSON rejects every supported btree comparison site but JSONB permits them', () => {
  for (const body of [
    'Table t { id json [pk] }',
    'Table t { id json [unique] }',
    "Table t { id json\n indexes { id [name: 'json_index'] } }",
    "Table t { id json\n indexes { id [name: 'json_unique', type: btree, unique] } }",
  ]) {
    expectFailure(project + body, 'DBML_INVALID');
    assert.equal(expectSchema(project + body.replace(' json', ' jsonb')).tables.length, 1);
  }
});

for (const flags of ['pk, unique', 'unique, pk']) {
  test(`DBML a primary index already supplies uniqueness: ${flags}`, () => {
    const table = expectSchema(project + `Table t { id int\n indexes { id [${flags}] } }`)
      .tables[0];
    assert.ok(table);
    assert.deepEqual(physical(table), {
      schema: 'public',
      name: 't',
      columns: [
        {
          name: 'id',
          type: { kind: 'builtin', schema: 'pg_catalog', name: 'int4', modifiers: [] },
          nullable: false,
        },
      ],
      primaryKey: { columns: ['id'] },
      uniqueKeys: [],
      foreignKeys: [],
      indexes: [],
    });
  });
}
