import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { normalizeDbml } from '../src/adapters/dbml.js';
import { normalizePostgres } from '../src/adapters/postgres.js';
import { emitPostgresEntities } from '../src/emit/postgres.js';
import { resolveNames } from '../src/resolve/names.js';
import { applications } from './dbml-application-expectations.js';
import { compileConsumer } from './emission-consumer-helpers.js';

type Metadata = DataSource['entityMetadatas'][number];

class MetadataSource extends DataSource {
  async buildForTest() {
    await this.buildMetadatas();
  }
}

for (const [name, expected] of Object.entries(applications)) {
  test(`${name}: strict ESM consumer executes and complete metadata preserves handwritten schema facts`, async () => {
    const source = await readFile(`tests/fixtures/applications/${name}.dbml`, 'utf8');
    const normalization = normalizeDbml(source, { target: 'postgres' });
    assert.ok(normalization.ok, JSON.stringify(normalization.diagnostics));
    const naming = resolveNames(normalization.schema);
    assert.ok(naming.ok, JSON.stringify(naming.diagnostics));
    const emission = emitPostgresEntities(naming.resolved);
    assert.ok(emission.ok, JSON.stringify(emission.diagnostics));
    const consumer = await compileConsumer(emission.files);
    try {
      assert.equal(consumer.entities.length, expected.tables.length);
      const metadata = new MetadataSource({ type: 'postgres', entities: consumer.entities });
      await metadata.buildForTest();
      assert.equal(metadata.entityMetadatas.length, expected.tables.length);
      for (const table of expected.tables) {
        const actual = metadata.entityMetadatas.find(
          (item) => item.tableName === table.name && item.schema === table.schema,
        );
        assert.ok(actual, `${table.schema}.${table.name}`);
        assert.deepEqual(
          actual.columns.map((column) => column.databaseName),
          table.columns.map((column) => column.name),
        );
        for (const column of table.columns) {
          const actualColumn: Metadata['columns'][number] = actual.columns.find(
            (item) => item.databaseName === column.name,
          )!;
          assert.equal(
            actualColumn.type,
            column.type.kind === 'enum'
              ? 'enum'
              : column.type.name === 'bpchar'
                ? 'character'
                : column.type.name,
            `${table.name}.${column.name} type`,
          );
          assert.equal(
            actualColumn.isNullable,
            column.nullable,
            `${table.name}.${column.name} nullable`,
          );
          const modifiers = column.type.modifiers;
          if (['varchar', 'bpchar'].includes(column.type.name))
            assert.equal(actualColumn.length, modifiers.length ? String(modifiers[0]) : '');
          else if (modifiers.length) {
            assert.equal(actualColumn.precision, modifiers[0]);
            if (modifiers.length > 1) assert.equal(actualColumn.scale, modifiers[1]);
          }
          if (column.type.kind === 'enum') {
            assert.equal(actualColumn.enumName, column.type.name);
            assert.deepEqual(
              actualColumn.enum,
              expected.enums.find(
                (item) => item.name === column.type.name && item.schema === column.type.schema,
              )!.values,
            );
          }
          assert.equal(actualColumn.isGenerated, false);
          if (!column.default) assert.equal(actualColumn.default, undefined);
          else {
            assert.ok(typeof actualColumn.default === 'function');
            const sql: string = actualColumn.default();
            if (column.default.kind === 'expression') assert.equal(sql, column.default.sql);
            else if (column.default.type === 'string')
              assert.equal(sql, `'${column.default.value.replaceAll("'", "''")}'`);
            else if (column.default.type === 'null') assert.equal(sql, 'NULL');
            else assert.equal(sql, String(column.default.value));
          }
        }
        assert.deepEqual(
          actual.primaryColumns.map((column) => column.databaseName),
          table.primaryKey!.columns,
        );
        assert.equal(
          actual.uniques.length,
          table.uniqueKeys.length,
          'No inferred unique constraints.',
        );
        for (const unique of table.uniqueKeys) {
          const found: Metadata['uniques'][number] | undefined = actual.uniques.find(
            (item) =>
              JSON.stringify(item.columns.map((column) => column.databaseName)) ===
              JSON.stringify(unique.columns),
          );
          assert.ok(found);
          if (unique.name) assert.equal(found.name, unique.name);
        }
        assert.deepEqual(
          actual.indices
            .map((item) => ({
              name: item.name,
              columns: item.columns.map((column) => column.databaseName),
              unique: item.isUnique,
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          table.indexes
            .map(({ name, columns, unique }) => ({ name, columns, unique }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        assert.equal(actual.foreignKeys.length, table.foreignKeys.length);
        for (const foreignKey of table.foreignKeys) {
          const found: Metadata['foreignKeys'][number] = actual.foreignKeys.find(
            (item) => item.name === foreignKey.name,
          )!;
          assert.ok(found, foreignKey.name);
          assert.deepEqual(
            found.columns.map((column) => column.databaseName),
            foreignKey.columns,
          );
          assert.equal(found.referencedEntityMetadata.schema, foreignKey.target.schema);
          assert.equal(found.referencedEntityMetadata.tableName, foreignKey.target.name);
          assert.deepEqual(
            found.referencedColumns.map((column) => column.databaseName),
            foreignKey.targetColumns,
          );
          assert.equal(found.onDelete, foreignKey.onDelete.toUpperCase());
          assert.equal(found.onUpdate, foreignKey.onUpdate.toUpperCase());
          assert.equal(found.deferrable, undefined);
        }
        assert.equal(actual.relations.length, table.foreignKeys.length);
        for (const [relationIndex, relation] of actual.relations.entries()) {
          const foreignKey = table.foreignKeys[relationIndex]!;
          assert.equal(relation.inverseEntityMetadata.schema, foreignKey.target.schema);
          assert.equal(relation.inverseEntityMetadata.tableName, foreignKey.target.name);
          const pairs = foreignKey.columns.map((name, index) => [
            name,
            foreignKey.targetColumns[index],
          ]);
          assert.deepEqual(
            relation.joinColumns
              .map((column) => [column.databaseName, column.referencedColumn!.databaseName])
              .sort(),
            pairs.sort(),
          );
          const oneToOne = [
            table.primaryKey,
            ...table.uniqueKeys,
            ...table.indexes.filter((index) => index.unique),
          ].some(
            (key) =>
              key &&
              key.columns.length === foreignKey.columns.length &&
              key.columns.every((name) => foreignKey.columns.includes(name)),
          );
          assert.equal(relation.relationType, oneToOne ? 'one-to-one' : 'many-to-one');
          assert.equal(relation.isLazy, false);
          assert.equal(relation.isEager, false);
          assert.equal(relation.isCascadeInsert, false);
          assert.equal(relation.isCascadeUpdate, false);
          assert.equal(relation.isCascadeRemove, false);
          assert.equal(relation.createForeignKeyConstraints, false);
          assert.equal(
            relation.isNullable,
            relation.joinColumns.some((column) => column.isNullable),
          );
        }
      }
    } finally {
      await consumer.cleanup();
    }
  });
}

test('named composite keys, identity modes, precision, overrides and cyclic relations compile and preserve metadata', async () => {
  const normalization = await normalizePostgres(
    `
    CREATE TABLE owners (code varchar(12) NOT NULL, id int NOT NULL,
      CONSTRAINT owners_pk PRIMARY KEY (code, id));
    CREATE TABLE records (id bigint GENERATED BY DEFAULT AS IDENTITY CONSTRAINT records_pk PRIMARY KEY,
      owner_code varchar(12), owner_id int, parent_id bigint,
      amount numeric(30, 8) DEFAULT 1234567890123456789012.34567890,
      fixed character(3), payload bytea, raw json, value jsonb,
      day date, tick time(6), zone timetz(6), moment timestamp(0),
      CONSTRAINT record_owner FOREIGN KEY (owner_code, owner_id) REFERENCES owners(code,id)
        ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT record_parent FOREIGN KEY (parent_id) REFERENCES records(id));
    CREATE TABLE always_ids (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
  `,
    { dialect: 'postgres', target: 'postgres' },
  );
  assert.ok(normalization.ok, JSON.stringify(normalization.diagnostics));
  const naming = resolveNames(normalization.schema, {
    tables: [
      {
        table: { schema: 'public', name: 'records' },
        className: '$orm',
        fileName: 'ledger.entity.ts',
        columns: [{ column: 'owner_code', propertyName: 'ownerCodeValue' }],
      },
      { table: { schema: 'public', name: 'owners' }, className: '$Target1' },
      { table: { schema: 'public', name: 'always_ids' }, className: '$Entity0' },
    ],
  });
  assert.ok(naming.ok, JSON.stringify(naming.diagnostics));
  const emission = emitPostgresEntities(naming.resolved);
  assert.ok(emission.ok, JSON.stringify(emission.diagnostics));
  const consumer = await compileConsumer(emission.files);
  try {
    const source = new MetadataSource({ type: 'postgres', entities: consumer.entities });
    await source.buildForTest();
    const records = source.entityMetadatas.find((item) => item.tableName === 'records')!;
    const id = records.columns.find((item) => item.databaseName === 'id')!;
    assert.equal(id.generationStrategy, 'identity');
    assert.equal(id.generatedIdentity, 'BY DEFAULT');
    assert.equal(id.primaryKeyConstraintName, 'records_pk');
    assert.equal(
      records.foreignKeys.find((item) => item.name === 'record_owner')!.deferrable,
      'INITIALLY DEFERRED',
    );
    assert.deepEqual(
      records.foreignKeys
        .find((item) => item.name === 'record_owner')!
        .columns.map((item) => item.propertyName),
      ['ownerCodeValue', 'ownerId'],
    );
    assert.equal(records.columns.find((item) => item.databaseName === 'moment')!.precision, 0);
    const amountDefault = records.columns.find((item) => item.databaseName === 'amount')!.default;
    assert.equal(typeof amountDefault, 'function');
    assert.equal((amountDefault as () => string)(), '1234567890123456789012.34567890');
    const always = source.entityMetadatas.find((item) => item.tableName === 'always_ids')!;
    assert.equal(always.primaryColumns[0]!.generatedIdentity, 'ALWAYS');
  } finally {
    await consumer.cleanup();
  }
});

test('scalar and nullable relationship types preserve the consumer contract', async () => {
  const normalization = await normalizePostgres(
    `
    CREATE TYPE mood AS ENUM ('new', 'closed');
    CREATE TABLE scalar_facts (
      id int PRIMARY KEY, small int2 NOT NULL, big int8 NOT NULL,
      amount numeric NOT NULL, single float4 NOT NULL, double_value float8 NOT NULL,
      flag bool NOT NULL, text_value text NOT NULL, code varchar(12) NOT NULL,
      fixed bpchar(3) NOT NULL, identifier uuid NOT NULL, bytes bytea NOT NULL,
      document json NOT NULL, payload jsonb NOT NULL, day date NOT NULL,
      clock time NOT NULL, zoned timetz NOT NULL, moment timestamp NOT NULL,
      instant timestamptz NOT NULL, state mood NOT NULL, optional varchar(4),
      parent_id int REFERENCES scalar_facts(id)
    );
  `,
    { dialect: 'postgres', target: 'postgres' },
  );
  assert.equal(normalization.ok, true);
  if (!normalization.ok) return;
  const naming = resolveNames(normalization.schema);
  assert.equal(naming.ok, true);
  if (!naming.ok) return;
  const emission = emitPostgresEntities(naming.resolved);
  assert.equal(emission.ok, true);
  if (!emission.ok) return;
  const consumer = await compileConsumer(
    emission.files,
    `
    import type { ScalarFacts } from './scalar-facts.entity.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
      (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    export type Checks = [
      Assert<Equal<ScalarFacts['id'], number>>,
      Assert<Equal<ScalarFacts['small'], number>>,
      Assert<Equal<ScalarFacts['big'], string>>,
      Assert<Equal<ScalarFacts['amount'], string>>,
      Assert<Equal<ScalarFacts['single'], number>>,
      Assert<Equal<ScalarFacts['doubleValue'], number>>,
      Assert<Equal<ScalarFacts['flag'], boolean>>,
      Assert<Equal<ScalarFacts['textValue'], string>>,
      Assert<Equal<ScalarFacts['code'], string>>,
      Assert<Equal<ScalarFacts['fixed'], string>>,
      Assert<Equal<ScalarFacts['identifier'], string>>,
      Assert<Equal<ScalarFacts['bytes'], Buffer>>,
      Assert<Equal<ScalarFacts['document'], unknown>>,
      Assert<Equal<ScalarFacts['payload'], unknown>>,
      Assert<Equal<ScalarFacts['day'], string>>,
      Assert<Equal<ScalarFacts['clock'], string>>,
      Assert<Equal<ScalarFacts['zoned'], string>>,
      Assert<Equal<ScalarFacts['moment'], Date>>,
      Assert<Equal<ScalarFacts['instant'], Date>>,
      Assert<Equal<ScalarFacts['state'], 'new' | 'closed'>>,
      Assert<Equal<ScalarFacts['optional'], string | null>>,
      Assert<Equal<ScalarFacts['parentId'], number | null>>,
      Assert<Equal<ScalarFacts['relation1'], ScalarFacts | null>>
    ];
  `,
  );
  await consumer.cleanup();
});

test('an empty schema compiles and imports as an empty registry', async () => {
  const normalization = await normalizePostgres('', { dialect: 'postgres', target: 'postgres' });
  assert.equal(normalization.ok, true);
  if (!normalization.ok) return;
  const naming = resolveNames(normalization.schema);
  assert.equal(naming.ok, true);
  if (!naming.ok) return;
  const emission = emitPostgresEntities(naming.resolved);
  assert.equal(emission.ok, true);
  if (!emission.ok) return;
  const consumer = await compileConsumer(emission.files);
  try {
    assert.deepEqual(consumer.entities, []);
  } finally {
    await consumer.cleanup();
  }
});
