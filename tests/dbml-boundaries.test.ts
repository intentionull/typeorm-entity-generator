import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDbml } from '../src/adapters/dbml.js';
import { expectFailure, expectSchema, project } from './dbml-test-helpers.js';

function commentBytes(bytes: number) {
  const prefix = project + '//';
  const remaining = bytes - Buffer.byteLength(prefix);
  const input = prefix + 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  assert.equal(Buffer.byteLength(input), bytes);
  return input;
}

for (const [name, limit, explicit] of [
  ['configured', 257, true],
  ['default', 1048576, false],
  ['maximum', 8388608, true],
] as const) {
  test(`DBML ${name} UTF-8 byte boundary accepts exactly the limit and rejects one more`, () => {
    const options = { target: 'postgres' as const, ...(explicit ? { maxInputBytes: limit } : {}) };
    const valid = normalizeDbml(commentBytes(limit), options);
    assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
    assert.deepEqual(valid.ok ? valid.schema.namespaces : [], ['public']);
    const invalid = normalizeDbml(commentBytes(limit + 1), options);
    assert.equal(invalid.ok, false);
    assert.equal('schema' in invalid, false);
    assert.equal(invalid.diagnostics[0]?.code, 'DBML_LIMIT');
    assert.match(invalid.diagnostics[0]?.message ?? '', /maxInputBytes/);
  });
}

test('DBML structural budget counts namespaces, enum labels, keys, indexes and references', () => {
  // 2 namespaces + enum + 2 labels + 2 tables + 6 columns + 2 primary keys
  // + unique constraint + 2 physical indexes + foreign key = 19 objects.
  const input =
    project +
    `Enum scoped.state { draft\n active }
    Table scoped.parent { tenant int [pk]\n id int [pk] }
    Table scoped.child {
      tenant int
      id int [pk]
      parent_id int
      state scoped.state
      indexes {
        (tenant, parent_id) [unique, name: 'child_pair']
        parent_id [type: btree, name: 'child_parent']
        (tenant, id) [unique, type: btree, name: 'child_identity']
      }
    }
    Ref child_parent_ref: scoped.child.(tenant, parent_id) > scoped.parent.(tenant, id)
    Note description { 'Presentation does not consume structural objects.' }
    TableGroup grouping { scoped.child }
  `;
  assert.equal(expectSchema(input, { target: 'postgres', maxObjects: 19 }).tables.length, 2);
  const diagnostic = expectFailure(input, 'DBML_LIMIT', { target: 'postgres', maxObjects: 18 });
  assert.match(diagnostic.message, /object/);
});

test('DBML default structural budget accepts 10000 objects and rejects 10001', () => {
  // Initial public namespace + one enum + 9998 labels.
  const labels = Array.from({ length: 9998 }, (_, i) => `value_${i}`);
  const input = project + `Enum status {\n${labels.join('\n')}\n}`;
  assert.equal(expectSchema(input).enums[0]?.values.length, 9998);
  expectFailure(input.replace('\n}', '\nextra\n}'), 'DBML_LIMIT');
});

test('DBML option numeric boundaries are inclusive and reject out-of-range values', () => {
  for (const maxInputBytes of [1, 8388608]) {
    const result = normalizeDbml(project, { target: 'postgres', maxInputBytes });
    assert.equal(
      result.ok ? undefined : result.diagnostics[0]?.code,
      maxInputBytes === 1 ? 'DBML_LIMIT' : undefined,
    );
  }
  for (const maxObjects of [1, 100000]) {
    assert.deepEqual(expectSchema(project, { target: 'postgres', maxObjects }).namespaces, [
      'public',
    ]);
  }
  for (const maxInputBytes of [0, 8388609, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectFailure(project, 'DBML_OPTIONS', { target: 'postgres', maxInputBytes });
  }
  for (const maxObjects of [0, 100001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectFailure(project, 'DBML_OPTIONS', { target: 'postgres', maxObjects });
  }
});

test('DBML scanner depth boundary allows 64 to reach parsing and rejects 65 before parsing', () => {
  // Synthetic invalid grammar isolates the scanner limit; this is not a supported nested schema.
  expectFailure(project + '('.repeat(64) + ')'.repeat(64), 'DBML_SYNTAX');
  const diagnostic = expectFailure(project + '('.repeat(65) + ')'.repeat(65), 'DBML_LIMIT');
  assert.match(diagnostic.message, /nesting/);
  assert.deepEqual(diagnostic.location, {
    offset: Buffer.byteLength(project) + 64,
    line: 2,
    column: 65,
  });
});

test('DBML scanner token boundary allows the exact budget to reach parsing and rejects one more', () => {
  // The project has seven lexical tokens. maxObjects=1 permits 1056 tokens in total.
  // Invalid top-level punctuation avoids conflating parser acceptance with the lexical ceiling.
  const options = { target: 'postgres' as const, maxObjects: 1 };
  const atLimit = project + '@ '.repeat(1049);
  expectFailure(atLimit, 'DBML_SYNTAX', options);
  const diagnostic = expectFailure(atLimit + '@', 'DBML_LIMIT', options);
  assert.match(diagnostic.message, /token budget/);
  assert.deepEqual(diagnostic.location, {
    offset: Buffer.byteLength(atLimit),
    line: 2,
    column: 2099,
  });
});

test('DBML quotes and comments are opaque to nesting and lexical budgets', () => {
  const opaque = '@ ( [ { '.repeat(1100);
  const schema = expectSchema(
    project + `// ${opaque}\n/* ${opaque} */\nNote description { '${opaque}' }`,
    { target: 'postgres', maxObjects: 1 },
  );
  assert.deepEqual(schema.tables, []);
});

for (const [label, exact, over] of [
  ['ASCII', 'x'.repeat(63), 'x'.repeat(64)],
  ['UTF-8', 'é'.repeat(31) + 'x', 'é'.repeat(32)],
  ['astral UTF-8', '😀'.repeat(15) + 'xxx', '😀'.repeat(16)],
]) {
  test(`DBML ${label} identifiers accept 63 bytes and reject 64 bytes at every object boundary`, () => {
    assert.equal(Buffer.byteLength(exact ?? ''), 63);
    assert.equal(Buffer.byteLength(over ?? ''), 64);
    const valid = expectSchema(
      project +
        `Enum "${exact}"."${exact}" { "${exact}" }
      Table "${exact}".records { "${exact}" "${exact}"."${exact}" }`,
    );
    assert.equal(valid.enums[0]?.values[0], exact);
    assert.equal(valid.tables[0]?.columns[0]?.name, exact);
    for (const body of [
      `Table "${over}".t { id int }`,
      `Table "${over}" { id int }`,
      `Table t { "${over}" int }`,
      `Enum "${over}" { value }`,
      `Enum e { "${over}" }`,
      `Table t { id int\n indexes { id [name: '${over}'] } }`,
      `Table p { id int [pk] }\nTable c { id int }\nRef "${over}": c.id > p.id`,
    ]) {
      expectFailure(project + body, 'DBML_INVALID');
      const accepted = expectSchema(project + body.replaceAll(over ?? '', exact ?? ''));
      assert.ok(
        JSON.stringify(accepted).includes(JSON.stringify(exact)),
        'The exact-limit name must be preserved.',
      );
    }
  });
}
