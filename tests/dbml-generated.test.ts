import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectFailure,
  expectSchema,
  physical,
  project,
  type SchemaFacts,
} from './dbml-test-helpers.js';

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
function quote(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
const specials = ['é', '😀', ' ', '.', '"', '\\', '{', ':', '$', 'Z', '_', 'Ω'];
const numbers = [
  '0',
  '-0',
  '+0',
  '0.125',
  '1.',
  '-1.25e-9',
  '+001.2300E+03',
  '900719925474099312345678901234567890',
];

for (const seed of [0x5eed1234, 0xc0ffee, 0x13579bdf]) {
  const next = random(seed);
  for (let round = 0; round < specials.length; round++) {
    const suffix = `${specials[round]}${next().toString(16)}`;
    const namespace = `scope_${suffix}`;
    const parent = `parent_${suffix}`;
    const child = `child_${suffix}`;
    const id = `id_${suffix}`;
    const numeric = numbers[round % numbers.length] ?? '0';
    const label = `label_${suffix}`;
    const q = quote;
    const p = `${q(namespace)}.${q(parent)}`;
    const c = `${q(namespace)}.${q(child)}`;
    const enumName = `state_${suffix}`;
    const parentSource = `Table ${p} { ${q(id)} int [pk] }`;
    const childSource = `Table ${c} {
      own_id int [pk]
      first_id bigint
      inline_id smallint [ref: > ${p}.${q(id)}]
      last_id int
      amount numeric [note: 'default: 999', default: ${numeric}]
      description text [default: ${q(label)}]
      state ${q(namespace)}.${q(enumName)} [default: ${q(label)}]
    }`;
    const parentFirst = (next() & 1) === 0;
    const before = (next() & 1) === 0;
    const first = `Ref first: ${p}.${q(id)} < ${c}.first_id`;
    const last = `Ref last: ${c}.last_id > ${p}.${q(id)}`;
    const enumSource = `Enum ${q(namespace)}.${q(enumName)} { ${q(label)} }`;
    const input =
      project +
      [
        before ? first : last,
        parentFirst ? parentSource : childSource,
        parentFirst ? childSource : parentSource,
        enumSource,
        before ? last : first,
      ].join('\n');
    test(`DBML generated schema seed=${seed.toString(16)} case=${round}`, () => {
      const builtin = (name: string) => ({
        kind: 'builtin' as const,
        schema: 'pg_catalog',
        name,
        modifiers: [],
      });
      const key = { columns: [id] };
      const parentFacts = {
        schema: namespace,
        name: parent,
        columns: [{ name: id, type: builtin('int4'), nullable: false }],
        primaryKey: key,
        uniqueKeys: [],
        indexes: [],
        foreignKeys: [],
      };
      const reference = (name: string | undefined, column: string) => ({
        ...(name ? { name } : {}),
        columns: [column],
        target: { schema: namespace, name: parent },
        targetColumns: [id],
        onDelete: 'no action' as const,
        onUpdate: 'no action' as const,
        match: 'simple' as const,
        deferrable: false,
        initiallyDeferred: false,
      });
      const firstFact = reference('first', 'first_id');
      const lastFact = reference('last', 'last_id');
      const childFacts = {
        schema: namespace,
        name: child,
        columns: [
          { name: 'own_id', type: builtin('int4'), nullable: false },
          { name: 'first_id', type: builtin('int8'), nullable: true },
          { name: 'inline_id', type: builtin('int2'), nullable: true },
          { name: 'last_id', type: builtin('int4'), nullable: true },
          {
            name: 'amount',
            type: builtin('numeric'),
            nullable: true,
            default: { kind: 'literal' as const, type: 'number' as const, value: numeric },
          },
          {
            name: 'description',
            type: builtin('text'),
            nullable: true,
            default: { kind: 'literal' as const, type: 'string' as const, value: label },
          },
          {
            name: 'state',
            type: { kind: 'enum' as const, schema: namespace, name: enumName, modifiers: [] },
            nullable: true,
            default: { kind: 'literal' as const, type: 'string' as const, value: label },
          },
        ],
        primaryKey: { columns: ['own_id'] },
        uniqueKeys: [],
        indexes: [],
        foreignKeys: [
          before ? firstFact : lastFact,
          reference(undefined, 'inline_id'),
          before ? lastFact : firstFact,
        ],
      };
      const expected: SchemaFacts = {
        version: 1,
        dialect: 'postgres',
        namespaces: ['public', namespace],
        enums: [{ schema: namespace, name: enumName, values: [label] }],
        tables: parentFirst ? [parentFacts, childFacts] : [childFacts, parentFacts],
      };
      const actual = expectSchema(input);
      assert.deepEqual(physical(actual), expected, input);
      assert.deepEqual(expectSchema(input), actual);
      actual.tables.length = 0;
      assert.deepEqual(physical(expectSchema(input)), expected, 'Returned state must be isolated.');
      // Each mutation creates a known invalid input without weakening the valid case's oracle.
      expectFailure(input + `\nTable ${p} { replacement int }`, 'DBML_SYNTAX');
      expectFailure(
        input +
          `\nTable ${q(namespace)}.collision {
        value int
        indexes { value [name: ${q(parent)}] }
      }`,
        'DBML_INVALID',
      );
      expectFailure(input + `\nEnum ${p} { value }`, 'DBML_INVALID');
    });
  }
}
