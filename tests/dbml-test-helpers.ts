import assert from 'node:assert/strict';
import { normalizeDbml } from '../src/adapters/dbml.js';
import type { DbmlOptions, SchemaDocument } from '../src/schema/model.js';

export const project = "Project fixture { database_type: 'PostgreSQL' }\n";

export type Facts<T> = T extends (infer U)[]
  ? Facts<U>[]
  : T extends object
    ? { [K in keyof T as Exclude<K, 'location'>]: Facts<T[K]> }
    : T;

export function physical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(physical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'location')
        .map(([key, entry]) => [key, physical(entry)]),
    );
  return value;
}

export function expectSchema(input: string, options: DbmlOptions = { target: 'postgres' }) {
  const result = normalizeDbml(input, options);
  assert.equal(result.ok, true, `${input}\n${JSON.stringify(result.diagnostics)}`);
  if (!result.ok) throw new Error('Expected successful normalization.');
  assert.deepEqual(result.diagnostics, []);
  return result.schema;
}

export function expectFailure(
  input: string,
  code: string,
  options: DbmlOptions = { target: 'postgres' },
) {
  const result = normalizeDbml(input, options);
  assert.equal(result.ok, false, input);
  assert.equal('schema' in result, false, 'A failed input must not expose a partial schema.');
  assert.equal(result.diagnostics[0]?.code, code, `${input}\n${JSON.stringify(result)}`);
  const diagnostic = result.diagnostics[0];
  assert.ok(diagnostic);
  assert.equal(diagnostic.severity, 'error');
  assert.ok(diagnostic.message.length > 0);
  assert.ok(Number.isInteger(diagnostic.location.offset) && diagnostic.location.offset >= 0);
  assert.ok(diagnostic.location.line >= 1 && diagnostic.location.column >= 1);
  return diagnostic;
}

export type SchemaFacts = Facts<SchemaDocument>;
