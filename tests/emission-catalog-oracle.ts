import type { ColumnDefault } from '../src/schema/model.js';
import type { SchemaFacts } from './dbml-test-helpers.js';

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const qualified = (schema: string, name: string) => `${identifier(schema)}.${identifier(name)}`;
const columns = (names: string[]) => names.map(identifier).join(', ');
const constraint = (name?: string) => (name ? `CONSTRAINT ${identifier(name)} ` : '');
function defaultSql(value: ColumnDefault): string {
  if (value.kind === 'expression') return value.sql;
  if (value.type === 'string') return `'${value.value.replaceAll("'", "''")}'`;
  if (value.type === 'null') return 'NULL';
  return String(value.value);
}

// Test-only DDL from the handwritten application oracles, never from parsed input or emission.
export function sqlFromFacts(facts: SchemaFacts): string {
  const statements = facts.namespaces
    .filter((name) => name !== 'public')
    .map((name) => `CREATE SCHEMA ${identifier(name)};`);
  for (const item of facts.enums)
    statements.push(
      `CREATE TYPE ${qualified(item.schema, item.name)} AS ENUM (${item.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')});`,
    );
  for (const table of facts.tables) {
    const definitions = table.columns.map((column) => {
      const modifiers = column.type.modifiers.length ? `(${column.type.modifiers.join(', ')})` : '';
      const type = qualified(column.type.schema, column.type.name) + modifiers;
      const required = column.nullable ? '' : ' NOT NULL';
      const value = column.default ? ` DEFAULT ${defaultSql(column.default)}` : '';
      return `${identifier(column.name)} ${type}${required}${value}`;
    });
    if (table.primaryKey)
      definitions.push(
        `${constraint(table.primaryKey.name)}PRIMARY KEY (${columns(table.primaryKey.columns)})`,
      );
    for (const key of table.uniqueKeys)
      definitions.push(`${constraint(key.name)}UNIQUE (${columns(key.columns)})`);
    statements.push(
      `CREATE TABLE ${qualified(table.schema, table.name)} (${definitions.join(', ')});`,
    );
    for (const index of table.indexes)
      statements.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${identifier(index.name)} ON ${qualified(table.schema, table.name)} USING ${index.method} (${columns(index.columns)});`,
      );
  }
  // Add references after all tables exist, including cycles and cross-schema targets.
  for (const table of facts.tables)
    for (const reference of table.foreignKeys) {
      const deferred = reference.deferrable
        ? ` DEFERRABLE INITIALLY ${reference.initiallyDeferred ? 'DEFERRED' : 'IMMEDIATE'}`
        : '';
      statements.push(
        `ALTER TABLE ${qualified(table.schema, table.name)} ADD ${constraint(reference.name)}FOREIGN KEY (${columns(reference.columns)}) REFERENCES ${qualified(reference.target.schema, reference.target.name)} (${columns(reference.targetColumns)}) MATCH ${reference.match} ON DELETE ${reference.onDelete} ON UPDATE ${reference.onUpdate}${deferred};`,
      );
    }
  return statements.join('\n');
}
