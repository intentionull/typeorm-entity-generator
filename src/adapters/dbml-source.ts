import type { Diagnostic, SourceLocation } from '../schema/model.js';

export type Node = Record<string, unknown>;
export function record(value: unknown): Node {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a DBML object.');
  return value as Node;
}
export function list(value: unknown): Node[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Expected a DBML list.');
  return value.map(record);
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected DBML text.');
  return value;
}
export class DbmlFailure extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
interface Token {
  start: number;
  end: number;
  text: string;
  quoted: boolean;
}

/** A source index, not a second DBML grammar. Quotes/comments are opaque to limit checks. */
export class DbmlSource {
  readonly tokens: Token[] = [];
  private readonly offsets: Uint32Array;
  private readonly lines: number[] = [0];
  constructor(
    readonly input: string,
    maxObjects: number,
  ) {
    this.offsets = new Uint32Array(input.length + 1);
    let bytes = 0;
    for (let i = 0; i < input.length; i++) {
      this.offsets[i] = bytes;
      const code = input.charCodeAt(i);
      if (code === 10) this.lines.push(i + 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        this.offsets[++i] = bytes;
        bytes += 4;
      } else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
    }
    this.offsets[input.length] = bytes;
    let i = 0;
    let depth = 0;
    while (i < input.length) {
      if (/\s/.test(input[i] ?? '')) {
        i++;
        continue;
      }
      if (input.startsWith('//', i)) {
        const end = input.indexOf('\n', i + 2);
        i = end < 0 ? input.length : end;
        continue;
      }
      if (input.startsWith('/*', i)) {
        const end = input.indexOf('*/', i + 2);
        if (end < 0) this.fail('DBML_SYNTAX', 'Unclosed block comment.', i);
        i = end + 2;
        continue;
      }
      const start = i;
      const char = input[i] ?? '';
      const quoted = ['"', "'", '`'].includes(char);
      if (quoted) {
        const delimiter = input.startsWith("'''", i) ? "'''" : char;
        i += delimiter.length;
        let closed = false;
        while (i < input.length) {
          if (input[i] === '\\') {
            i += 2;
            continue;
          }
          if (input.startsWith(delimiter, i)) {
            i += delimiter.length;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) this.fail('DBML_SYNTAX', 'Unclosed quoted value.', start);
      } else {
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i));
        const word = /^[\p{L}\p{N}_$]+/u.exec(input.slice(i));
        i += number?.[0].length ?? word?.[0].length ?? 1;
        if ('{[('.includes(char)) depth++;
        if ('}])'.includes(char)) depth--;
        if (depth > 64) this.fail('DBML_LIMIT', 'DBML nesting exceeds 64 levels.', start);
      }
      this.tokens.push({ start, end: i, text: input.slice(start, i), quoted });
      if (this.tokens.length > maxObjects * 32 + 1024)
        this.fail('DBML_LIMIT', 'DBML lexical token budget exceeded; split the schema.', start);
    }
  }
  location(index = 0): SourceLocation {
    const at = Math.max(0, Math.min(index, this.input.length));
    let low = 0;
    let high = this.lines.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.lines[mid] ?? 0) <= at) low = mid + 1;
      else high = mid;
    }
    return {
      offset: this.offsets[at] ?? 0,
      line: low,
      column: at - (this.lines[low - 1] ?? 0) + 1,
    };
  }
  index(node: Node, fallback = 0): number {
    if (!node.token) return fallback;
    const value = record(record(node.token).start).offset;
    // The compiler uses -1 for a composite primary key synthesized from column flags.
    if (value === -1) return fallback;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > this.input.length
    )
      throw new Error('Invalid DBML source offset.');
    return value;
  }
  atPosition(line: unknown, column: unknown): number {
    if (typeof line !== 'number' || typeof column !== 'number') return 0;
    return (this.lines[line - 1] ?? 0) + Math.max(0, column - 1);
  }
  fail(code: string, message: string, index = 0): never {
    throw new DbmlFailure({ code, severity: 'error', location: this.location(index), message });
  }
  /** The raw compiler stores numbers as doubles. Recover only the declared default token. */
  numericDefault(node: Node): string {
    const start = this.index(node);
    const end = record(record(node.token).end).offset;
    if (typeof end !== 'number') throw new Error('Missing DBML field end offset.');
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((this.tokens[mid]?.start ?? 0) < start) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (!token || token.start >= end) break;
      if (
        token.quoted ||
        token.text.toLowerCase() !== 'default' ||
        this.tokens[i + 1]?.text !== ':'
      )
        continue;
      let number = this.tokens[i + 2]?.text ?? '';
      if (number === '-' || number === '+') number += this.tokens[i + 3]?.text ?? '';
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(number))
        throw new Error('DBML numeric default has no matching source token.');
      return number;
    }
    throw new Error('DBML numeric default has no source declaration.');
  }
}
