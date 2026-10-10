import type { ColumnDefault, SourceLocation } from '../schema/model.js';

export type Ast = Record<string, unknown>;
export const record = (value: unknown): Ast => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Unexpected PostgreSQL parser node');
  }
  return value as Ast;
};
export const list = (value: unknown): unknown[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : (() => {
          throw new Error('Unexpected PostgreSQL parser list');
        })();
export const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Unexpected PostgreSQL parser string');
  return value;
};
export const stringList = (value: unknown): string[] =>
  list(value).map((v) => text(record(record(v).String).sval ?? ''));
export const identity = (schema: string, name: string): string => JSON.stringify([schema, name]);

export interface Token {
  start: number;
  end: number;
  text: string;
  tokenName: string;
}

export class Source {
  readonly bytes: Buffer;
  readonly lineStarts = [0];
  readonly defaults: number[] = [];
  constructor(
    readonly sql: string,
    readonly tokens: Token[],
  ) {
    this.bytes = Buffer.from(sql, 'utf8');
    for (let i = 0; i < this.bytes.length; i++)
      if (this.bytes[i] === 10) this.lineStarts.push(i + 1);
    for (const [index, token] of tokens.entries())
      if (token.text.toUpperCase() === 'DEFAULT') this.defaults.push(index);
  }
  location(offset: number): SourceLocation {
    const safe = Math.max(0, Math.min(offset, this.bytes.length));
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= safe) low = middle;
      else high = middle;
    }
    const prefix = this.bytes.subarray(this.lineStarts[low] ?? 0, safe).toString('utf8');
    return { offset: safe, line: low + 1, column: [...prefix].length + 1 };
  }
  /** Extract a parsed DEFAULT using scanner boundaries, not punctuation inside strings/comments. */
  defaultText(offset: number): string {
    let low = 0;
    let high = this.defaults.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const token = this.tokens[this.defaults[middle] ?? -1];
      if (token && token.start <= offset) low = middle + 1;
      else high = middle;
    }
    const start = (this.defaults[low - 1] ?? -2) + 1;
    const first = this.tokens[start];
    if (!first) throw new Error('Missing DEFAULT token');
    let depth = 0;
    let end = first.end;
    for (let i = start; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (!token) break;
      const word = token.text.toUpperCase();
      if (
        depth === 0 &&
        (word === ')' ||
          word === ',' ||
          word === ';' ||
          (i > start &&
            [
              'NOT',
              'NULL',
              'CONSTRAINT',
              'PRIMARY',
              'UNIQUE',
              'REFERENCES',
              'CHECK',
              'GENERATED',
            ].includes(word)))
      )
        break;
      if (word === '(') depth++;
      if (word === ')') depth--;
      end = token.end;
    }
    return this.bytes.subarray(first.start, end).toString('utf8').trim();
  }
}

export function nodeOffset(value: unknown, fallback: number): number {
  if (typeof value !== 'object' || value === null) return fallback;
  let offset = Number.POSITIVE_INFINITY;
  function visit(item: unknown): void {
    if (typeof item !== 'object' || item === null) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    const node = record(item);
    if (typeof node.location === 'number' && node.location >= 0)
      offset = Math.min(offset, node.location);
    for (const [key, child] of Object.entries(node)) if (key !== 'location') visit(child);
  }
  visit(value);
  return Number.isFinite(offset) ? offset : fallback;
}

export function literal(value: unknown): ColumnDefault | undefined {
  const node = record(value);
  if (!node.A_Const) return undefined;
  const constant = record(node.A_Const);
  if (constant.isnull === true) return { kind: 'literal', type: 'null', value: null };
  if (constant.sval)
    return { kind: 'literal', type: 'string', value: text(record(constant.sval).sval ?? '') };
  if (constant.boolval)
    return { kind: 'literal', type: 'boolean', value: record(constant.boolval).boolval === true };
  if (constant.ival)
    return { kind: 'literal', type: 'number', value: String(record(constant.ival).ival ?? 0) };
  if (constant.fval)
    return { kind: 'literal', type: 'number', value: text(record(constant.fval).fval) };
  throw new Error('Unexpected PostgreSQL constant');
}
