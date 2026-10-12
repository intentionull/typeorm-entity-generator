import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DataSource } from 'typeorm';
import { normalizeDbml } from '../src/adapters/dbml.js';
import { normalizePostgres } from '../src/adapters/postgres.js';
import { emitPostgresEntities } from '../src/emit/postgres.js';
import { resolveNames } from '../src/resolve/names.js';
import { compileConsumer } from './emission-consumer-helpers.js';
import { applications } from './dbml-application-expectations.js';
import { sqlFromFacts } from './emission-catalog-oracle.js';

const host = process.env.SCHEMA_TEST_HOST ?? '';
assert.ok(
  host === '127.0.0.1' || host?.startsWith('/tmp/'),
  'Catalog tests require an explicitly configured loopback host or disposable /tmp Unix socket.',
);
const connection = {
  type: 'postgres' as const,
  host,
  port: Number(process.env.SCHEMA_TEST_PORT ?? '5432'),
  username: process.env.SCHEMA_TEST_USER ?? 'postgres',
};

const columnsQuery = `SELECT n.nspname AS schema, t.relname AS table,
  a.attname AS name, tn.nspname AS type_schema, ty.typname AS type,
  a.atttypmod AS modifier, a.attnotnull AS required, a.attidentity AS identity,
  pg_get_expr(d.adbin, d.adrelid) AS default
  FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_type ty ON ty.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = ty.typnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE t.relkind = 'r' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    AND a.attnum > 0 AND NOT a.attisdropped ORDER BY n.nspname, t.relname, a.attnum`;
const constraintsQuery = `SELECT n.nspname AS schema, t.relname AS table,
  CASE WHEN c.conname = ANY($1::text[]) THEN c.conname ELSE NULL END AS name,
  c.contype AS type,
  ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.num ORDER BY k.pos) AS columns,
  rn.nspname AS target_schema, rt.relname AS target_table,
  ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
    JOIN pg_attribute a ON a.attrelid = rt.oid AND a.attnum = k.num ORDER BY k.pos) AS target_columns,
  c.confupdtype AS on_update, c.confdeltype AS on_delete, c.confmatchtype AS match,
  c.condeferrable AS deferrable, c.condeferred AS deferred
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_class rt ON rt.oid = c.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE c.contype IN ('p','u','f') AND n.nspname NOT LIKE 'pg_%'
    AND n.nspname <> 'information_schema'`;
const indexesQuery = `SELECT n.nspname AS schema, t.relname AS table, idx.relname AS name,
  i.indisunique AS unique, m.amname AS method,
  ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(num, pos)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.num ORDER BY k.pos) AS columns
  FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_am m ON m.oid = idx.relam
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p', 'u'))
  ORDER BY n.nspname, t.relname, idx.relname`;
const enumsQuery = `SELECT n.nspname AS schema, t.typname AS name,
  array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE n.nspname NOT LIKE 'pg_%' GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname`;

async function catalog(source: DataSource, names: string[]) {
  const constraints: Record<string, unknown>[] = await source.query(constraintsQuery, [names]);
  constraints.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    columns: await source.query(columnsQuery),
    constraints,
    indexes: await source.query(indexesQuery),
    enums: await source.query(enumsQuery),
    namespaces: await source.query(
      "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname",
    ),
  };
}

const actions = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'];
const focused =
  `
  CREATE SCHEMA billing;
  CREATE TYPE billing.state AS ENUM ('open', 'customer''s hold', 'closed');
  CREATE TABLE billing.accounts (a int NOT NULL, b int NOT NULL, CONSTRAINT accounts_pk PRIMARY KEY(a,b));
  CREATE TABLE billing.records (
    id bigint GENERATED ALWAYS AS IDENTITY CONSTRAINT records_pk PRIMARY KEY,
    account_b int, account_a int, parent bigint,
    state billing.state NOT NULL DEFAULT 'customer''s hold',
    amount numeric(30,8) DEFAULT 1234567890123456789012.34567890,
    fixed character(3), bytes bytea, day date,
    small int2, single_float float4, unconstrained numeric, precision_only numeric(12), rounded numeric(12,-2),
    clock time(6), clock_zone timetz(6), stamp timestamp(0), stamp_zone timestamptz(3),
    enabled bool DEFAULT false, raw json DEFAULT '{"x":1}', value jsonb DEFAULT '{}',
    nullable_default text DEFAULT NULL, label text DEFAULT 'a''b', float_value float8 DEFAULT 0.125,
    CONSTRAINT records_owner FOREIGN KEY(account_b,account_a) REFERENCES billing.accounts(b,a)
      ON DELETE SET NULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT records_parent FOREIGN KEY(parent) REFERENCES billing.records(id));
  CREATE UNIQUE INDEX record_label_idx ON billing.records(label);
  CREATE TABLE ordinary (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);
  CREATE TABLE codes (id int PRIMARY KEY, code varchar(12) NOT NULL);
  CREATE UNIQUE INDEX codes_lookup ON codes(code);
  CREATE TABLE code_uses (id int PRIMARY KEY, code varchar(12) REFERENCES codes(code));
  CREATE TABLE action_targets (id int PRIMARY KEY);
` +
  actions
    .flatMap((onDelete, deleteIndex) =>
      actions.map(
        (onUpdate, updateIndex) => `
  CREATE TABLE action_${deleteIndex}_${updateIndex} (
    id int PRIMARY KEY, target_id int DEFAULT 1,
    CONSTRAINT action_fk_${deleteIndex}_${updateIndex} FOREIGN KEY (target_id)
      REFERENCES action_targets(id) ON DELETE ${onDelete} ON UPDATE ${onUpdate}
      DEFERRABLE INITIALLY IMMEDIATE
  );
`,
      ),
    )
    .join('\n');

for (const fixture of ['basic', 'tenant', 'quoted', 'focused', ...Object.keys(applications)]) {
  for (const input of applications[fixture]
    ? ['dbml']
    : fixture === 'focused'
      ? ['sql']
      : ['sql', 'dbml']) {
    test(`${fixture}/${input}: PostgreSQL catalog matches independently executed source DDL`, async () => {
      const facts = applications[fixture];
      const sql = facts
        ? sqlFromFacts(facts)
        : fixture === 'focused'
          ? focused
          : await readFile(`tests/fixtures/pairs/${fixture}.sql`, 'utf8');
      const normalization =
        input === 'sql'
          ? await normalizePostgres(sql, { dialect: 'postgres', target: 'postgres' })
          : normalizeDbml(
              await readFile(
                `tests/fixtures/${facts ? 'applications' : 'pairs'}/${fixture}.dbml`,
                'utf8',
              ),
              {
                target: 'postgres',
              },
            );
      assert.ok(normalization.ok, JSON.stringify(normalization.diagnostics));
      const naming = resolveNames(normalization.schema);
      assert.ok(naming.ok, JSON.stringify(naming.diagnostics));
      const emission = emitPostgresEntities(naming.resolved);
      assert.ok(emission.ok, JSON.stringify(emission.diagnostics));
      const consumer = await compileConsumer(emission.files);
      const admin = new DataSource({ ...connection, database: 'postgres' });
      const suffix = randomUUID().replaceAll('-', '');
      const originalName = `entity_test_source_${suffix}`;
      const emittedName = `entity_test_emitted_${suffix}`;
      const original = new DataSource({ ...connection, database: originalName });
      const emitted = new DataSource({
        ...connection,
        database: emittedName,
        entities: consumer.entities,
      });
      const created: string[] = [];
      try {
        await admin.initialize();
        for (const name of [originalName, emittedName]) {
          await admin.query(`CREATE DATABASE "${name}"`);
          created.push(name);
        }
        await original.initialize();
        await emitted.initialize();
        await original.query(sql);
        // Namespaces are provisioned by the consumer, not by entity decorators.
        const runner = emitted.createQueryRunner();
        try {
          for (const schema of new Set(emitted.entityMetadatas.map((item) => item.schema))) {
            if (schema && schema !== 'public') await runner.createSchema(schema, true);
          }
        } finally {
          await runner.release();
        }
        await emitted.synchronize();
        const names = normalization.schema.tables.flatMap((table) =>
          [
            table.primaryKey?.name,
            ...table.uniqueKeys.map((item) => item.name),
            ...table.foreignKeys.map((item) => item.name),
          ].filter((name): name is string => name !== undefined),
        );
        const sourceCatalog = await catalog(original, names);
        if (fixture === 'focused') {
          assert.ok(
            sourceCatalog.indexes.some((index: { name: string }) => index.name === 'codes_lookup'),
            'Referenced standalone unique indexes stay in the catalog oracle.',
          );
        }
        assert.deepEqual(await catalog(emitted, names), sourceCatalog);
      } finally {
        for (const source of [original, emitted]) if (source.isInitialized) await source.destroy();
        if (admin.isInitialized) {
          try {
            for (const name of created) await admin.query(`DROP DATABASE "${name}"`);
          } finally {
            await admin.destroy();
          }
        }
        await consumer.cleanup();
      }
    });
  }
}
