import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Parser } from '@dbml/core';
import { parse as parseSql } from 'libpg-query';

const root = fileURLToPath(new URL('./fixtures/', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const json = async (name) => JSON.parse(await read(name));
const parseDbml = (text) => new Parser().parse(text, 'dbmlv2');
const sorted = (values) => [...values].sort();

function summary(database) {
  return {
    tables: sorted(
      database.schemas.flatMap((schema) =>
        schema.tables.map((table) => `${schema.name}.${table.name}`),
      ),
    ),
    enums: sorted(
      database.schemas.flatMap((schema) =>
        schema.enums.map((entry) => `${schema.name}.${entry.name}`),
      ),
    ),
    references: database.schemas.reduce((count, schema) => count + schema.refs.length, 0),
  };
}

function table(database, schema, name) {
  const result = database.schemas
    .find((entry) => entry.name === schema)
    ?.tables.find((entry) => entry.name === name);
  assert.ok(result, `Missing table ${schema}.${name}`);
  return result;
}

function column(table, name) {
  const result = table.fields.find((entry) => entry.name === name);
  assert.ok(result, `Missing column ${name}`);
  return result;
}

function sqlTable(ast, schema, name) {
  const result = ast.stmts
    .map((entry) => entry.stmt.CreateStmt)
    .find(
      (entry) =>
        entry &&
        (entry.relation.schemaname ?? 'public') === schema &&
        entry.relation.relname === name,
    );
  assert.ok(result, `Missing SQL table ${schema}.${name}`);
  return result;
}

function sqlColumn(table, name) {
  const result = table.tableElts
    .map((entry) => entry.ColumnDef)
    .find((entry) => entry?.colname === name);
  assert.ok(result, `Missing SQL column ${name}`);
  return result;
}

function constraints(table, columnName) {
  return columnName
    ? (sqlColumn(table, columnName).constraints ?? []).map((entry) => entry.Constraint)
    : table.tableElts.filter((entry) => entry.Constraint).map((entry) => entry.Constraint);
}

function names(nodes) {
  return nodes.map((entry) => entry.String.sval);
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    result.push(...(entry.isDirectory() ? await files(name) : [name]));
  }
  return result;
}

test('upstream corpus has complete provenance and checked parser expectations', async (t) => {
  const manifest = await json('upstream/manifest.json');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.parser.name, '@dbml/core');
  assert.equal(manifest.parser.version, '10.3.1');
  assert.equal(manifest.parser.mode, 'dbmlv2');
  assert.equal(manifest.samples.length, 9);
  assert.equal(new Set(manifest.samples.map((entry) => entry.id)).size, 9);
  const tracked = ['upstream/manifest.json'];
  for (const source of manifest.sources) {
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.match(source.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    for (const file of source.legalFiles) {
      tracked.push(file.localPath);
      assert.equal(
        createHash('sha256')
          .update(await readFile(path.join(root, file.localPath)))
          .digest('hex'),
        file.sha256,
      );
      const text = await read(file.localPath);
      assert.match(
        text,
        source.license === 'MIT' ? /Permission is hereby granted/ : /Apache License/,
      );
      assert.equal(file.url, `${source.repository}/blob/${source.commit}/${file.path}`);
    }
  }
  for (const sample of manifest.samples) {
    await t.test(sample.id, async () => {
      const source = manifest.sources.find((entry) => entry.id === sample.source);
      assert.ok(source);
      assert.equal(sample.url, `${source.repository}/blob/${source.commit}/${sample.path}`);
      tracked.push(sample.localPath);
      const bytes = await readFile(path.join(root, sample.localPath));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
      assert.equal(sample.modified, false);
      if (sample.expected.outcome === 'accept') {
        assert.deepEqual(summary(parseDbml(bytes.toString('utf8'))), sample.expected.summary);
      } else {
        assert.equal(sample.expected.outcome, 'reject');
        assert.throws(
          () => parseDbml(bytes.toString('utf8')),
          (error) => {
            assert.ok(Array.isArray(error.diags) && error.diags.length > 0);
            for (const diagnostic of sample.expected.messages) {
              assert.ok(
                error.diags.some((entry) => entry.message === diagnostic),
                diagnostic,
              );
            }
            return true;
          },
        );
      }
    });
  }
  assert.deepEqual(sorted(await files('upstream')), sorted(tracked));
});

test('local invalid inputs fail with the intended diagnostic, not a generic exception', async (t) => {
  const cases = await json('invalid/expectations.json');
  assert.equal(cases.length, 4);
  assert.deepEqual(
    sorted((await files('invalid')).filter((name) => name.endsWith('.dbml'))),
    sorted(cases.map((entry) => `invalid/${entry.file}`)),
  );
  for (const entry of cases) {
    await t.test(entry.file, async () => {
      const input = await read(`invalid/${entry.file}`);
      assert.throws(
        () => parseDbml(input),
        (error) => {
          assert.ok(
            error.diags?.some((diagnostic) => diagnostic.message.includes(entry.message)),
            JSON.stringify(error.diags),
          );
          return true;
        },
      );
    });
  }
});

test('basic pair independently declares columns, defaults, precision, keys, and nullability', async () => {
  const db = parseDbml(await read('pairs/basic.dbml'));
  const ast = await parseSql(await read('pairs/basic.sql'));
  assert.deepEqual(summary(db), { tables: ['public.accounts'], enums: [], references: 0 });
  const dbTable = table(db, 'public', 'accounts');
  const sql = sqlTable(ast, 'public', 'accounts');
  const expectedNames = ['id', 'email', 'enabled', 'balance', 'nickname', 'created_at'];
  assert.deepEqual(
    dbTable.fields.map((entry) => entry.name),
    expectedNames,
  );
  assert.deepEqual(
    sql.tableElts.filter((entry) => entry.ColumnDef).map((entry) => entry.ColumnDef.colname),
    expectedNames,
  );
  assert.equal(column(dbTable, 'id').pk, true);
  assert.ok(constraints(sql, 'id').some((entry) => entry.contype === 'CONSTR_PRIMARY'));
  assert.equal(column(dbTable, 'email').not_null, true);
  assert.equal(column(dbTable, 'email').unique, true);
  assert.ok(constraints(sql, 'email').some((entry) => entry.contype === 'CONSTR_NOTNULL'));
  assert.ok(constraints(sql, 'email').some((entry) => entry.contype === 'CONSTR_UNIQUE'));
  assert.equal(column(dbTable, 'email').type.type_name, 'varchar(255)');
  assert.equal(sqlColumn(sql, 'email').typeName.typmods[0].A_Const.ival.ival, 255);
  assert.equal(column(dbTable, 'balance').type.type_name, 'numeric(12,2)');
  assert.deepEqual(
    sqlColumn(sql, 'balance').typeName.typmods.map((entry) => entry.A_Const.ival.ival),
    [12, 2],
  );
  assert.equal(column(dbTable, 'balance').dbdefault.value, 0);
  const zero = constraints(sql, 'balance').find((entry) => entry.contype === 'CONSTR_DEFAULT')
    .raw_expr.A_Const.ival;
  assert.ok(zero);
  // The parser omits the numeric value when it is zero, retaining the integer node.
  assert.equal(zero.ival ?? 0, 0);
  assert.deepEqual(column(dbTable, 'enabled').dbdefault, { type: 'boolean', value: 'true' });
  assert.equal(
    constraints(sql, 'enabled').find((entry) => entry.contype === 'CONSTR_DEFAULT').raw_expr.A_Const
      .boolval.boolval,
    true,
  );
  assert.notEqual(column(dbTable, 'nickname').not_null, true);
  assert.ok(!constraints(sql, 'nickname').some((entry) => entry.contype === 'CONSTR_NOTNULL'));
  assert.deepEqual(column(dbTable, 'created_at').dbdefault, { type: 'expression', value: 'now()' });
  assert.deepEqual(
    names(
      constraints(sql, 'created_at').find((entry) => entry.contype === 'CONSTR_DEFAULT').raw_expr
        .FuncCall.funcname,
    ),
    ['now'],
  );
});

test('tenant pair independently declares enums, composite keys, and ordered foreign-key columns', async () => {
  const db = parseDbml(await read('pairs/tenant.dbml'));
  const ast = await parseSql(await read('pairs/tenant.sql'));
  assert.deepEqual(summary(db), {
    tables: ['tenant.accounts', 'tenant.orders'],
    enums: ['tenant.order_status'],
    references: 1,
  });
  const values = ['pending', 'complete', "customer's hold"];
  assert.deepEqual(
    db.schemas.find((entry) => entry.name === 'tenant').enums[0].values.map((entry) => entry.name),
    values,
  );
  const sqlEnum = ast.stmts.find((entry) => entry.stmt.CreateEnumStmt).stmt.CreateEnumStmt;
  assert.deepEqual(names(sqlEnum.typeName), ['tenant', 'order_status']);
  assert.deepEqual(names(sqlEnum.vals), values);
  for (const name of ['accounts', 'orders']) {
    const dbTable = table(db, 'tenant', name);
    assert.deepEqual(
      dbTable.indexes.find((entry) => entry.pk).columns.map((entry) => entry.value),
      ['tenant_id', 'id'],
    );
    assert.deepEqual(
      names(
        constraints(sqlTable(ast, 'tenant', name)).find(
          (entry) => entry.contype === 'CONSTR_PRIMARY',
        ).keys,
      ),
      ['tenant_id', 'id'],
    );
  }
  const ref = db.schemas.flatMap((entry) => entry.refs)[0];
  assert.deepEqual(
    ref.endpoints.map((entry) => ({
      table: `${entry.schemaName}.${entry.tableName}`,
      columns: entry.fieldNames,
      relation: entry.relation,
    })),
    [
      { table: 'tenant.orders', columns: ['tenant_id', 'account_id'], relation: '*' },
      { table: 'tenant.accounts', columns: ['tenant_id', 'id'], relation: '1' },
    ],
  );
  assert.equal(ref.onDelete, 'no action');
  assert.equal(ref.onUpdate, 'cascade');
  const fk = constraints(sqlTable(ast, 'tenant', 'orders')).find(
    (entry) => entry.contype === 'CONSTR_FOREIGN',
  );
  assert.deepEqual(names(fk.fk_attrs), ['tenant_id', 'account_id']);
  assert.equal(fk.pktable.schemaname, 'tenant');
  assert.equal(fk.pktable.relname, 'accounts');
  assert.deepEqual(names(fk.pk_attrs), ['tenant_id', 'id']);
  assert.equal(fk.fk_del_action, 'a');
  assert.equal(fk.fk_upd_action, 'c');
  const dbOrders = table(db, 'tenant', 'orders');
  assert.equal(column(dbOrders, 'status').dbdefault.value, 'pending');
  assert.equal(
    constraints(sqlTable(ast, 'tenant', 'orders'), 'status').find(
      (entry) => entry.contype === 'CONSTR_DEFAULT',
    ).raw_expr.A_Const.sval.sval,
    'pending',
  );
  assert.deepEqual(
    dbOrders.indexes.find((entry) => entry.unique).columns.map((entry) => entry.value),
    ['tenant_id', 'order_code'],
  );
  assert.deepEqual(
    names(
      constraints(sqlTable(ast, 'tenant', 'orders')).find(
        (entry) => entry.contype === 'CONSTR_UNIQUE',
      ).keys,
    ),
    ['tenant_id', 'order_code'],
  );
});

test('quoted pair preserves physical identifiers, nullable self-reference, and index method', async () => {
  const db = parseDbml(await read('pairs/quoted.dbml'));
  const ast = await parseSql(await read('pairs/quoted.sql'));
  assert.deepEqual(summary(db), { tables: ['Sales Team.Member Record'], enums: [], references: 1 });
  const dbTable = table(db, 'Sales Team', 'Member Record');
  const sql = sqlTable(ast, 'Sales Team', 'Member Record');
  assert.notEqual(column(dbTable, 'Manager Id').not_null, true);
  const ref = db.schemas.flatMap((entry) => entry.refs)[0];
  assert.deepEqual(
    ref.endpoints.map((entry) => entry.fieldNames),
    [['Manager Id'], ['Member Id']],
  );
  assert.ok(
    ref.endpoints.every(
      (entry) => entry.tableName === 'Member Record' && entry.schemaName === 'Sales Team',
    ),
  );
  const fk = constraints(sql, 'Manager Id').find((entry) => entry.contype === 'CONSTR_FOREIGN');
  assert.equal(fk.pktable.relname, 'Member Record');
  assert.equal(fk.pktable.schemaname, 'Sales Team');
  assert.deepEqual(names(fk.pk_attrs), ['Member Id']);
  assert.equal(column(dbTable, 'Display Name').not_null, true);
  assert.equal(column(dbTable, 'Display Name').type.type_name, 'varchar(80)');
  assert.ok(constraints(sql, 'Display Name').some((entry) => entry.contype === 'CONSTR_NOTNULL'));
  assert.equal(sqlColumn(sql, 'Display Name').typeName.typmods[0].A_Const.ival.ival, 80);
  assert.equal(dbTable.indexes[0].name, 'Member Manager Index');
  assert.equal(dbTable.indexes[0].type, 'btree');
  const index = ast.stmts.find((entry) => entry.stmt.IndexStmt).stmt.IndexStmt;
  assert.equal(index.idxname, 'Member Manager Index');
  assert.equal(index.accessMethod, 'btree');
  assert.equal(index.indexParams[0].IndexElem.name, 'Manager Id');
});
