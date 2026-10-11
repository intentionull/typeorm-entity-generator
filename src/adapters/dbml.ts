import { createRequire } from 'node:module';
import type {
  ColumnDefault,
  DatabaseType,
  DbmlOptions,
  ForeignKey,
  Key,
  NormalizationResult,
  QualifiedName,
  ReferentialAction,
  SchemaDocument,
  Table,
} from '../schema/model.js';
import { DbmlFailure, DbmlSource, list, type Node, record, text } from './dbml-source.js';

// The upstream declarations include optional editor modules. Keep the runtime contract narrow.
const parserModule: unknown = createRequire(import.meta.url)('@dbml/core');
function parseDbml(input: string): unknown {
  const parser = record(parserModule).Parser;
  if (
    typeof parser !== 'function' ||
    !('parseDBMLToJSONv2' in parser) ||
    typeof parser.parseDBMLToJSONv2 !== 'function'
  )
    throw new Error('Missing DBML v2 parser entry point.');
  return parser.parseDBMLToJSONv2(input);
}

const aliases: Record<string, string> = {
  int: 'int4',
  integer: 'int4',
  int4: 'int4',
  smallint: 'int2',
  int2: 'int2',
  bigint: 'int8',
  int8: 'int8',
  boolean: 'bool',
  bool: 'bool',
  text: 'text',
  varchar: 'varchar',
  'character varying': 'varchar',
  char: 'bpchar',
  character: 'bpchar',
  bpchar: 'bpchar',
  decimal: 'numeric',
  numeric: 'numeric',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  date: 'date',
  timestamp: 'timestamp',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
  timestamptz: 'timestamptz',
  time: 'time',
  'time without time zone': 'time',
  'time with time zone': 'timetz',
  timetz: 'timetz',
  real: 'float4',
  float4: 'float4',
  'double precision': 'float8',
  float8: 'float8',
  bytea: 'bytea',
};
const actions = new Set(['no action', 'restrict', 'cascade', 'set null', 'set default']);
const integers = new Set(['int2', 'int4', 'int8']);
function id(value: QualifiedName): string {
  return JSON.stringify([value.schema, value.name]);
}
function sameColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column) => right.includes(column));
}
function compatible(left: DatabaseType, right: DatabaseType): boolean {
  if (left.kind === right.kind && left.schema === right.schema && left.name === right.name)
    return true;
  if (left.kind !== 'builtin' || right.kind !== 'builtin') return false;
  return (
    (integers.has(left.name) && integers.has(right.name)) ||
    (['text', 'varchar'].includes(left.name) && ['text', 'varchar'].includes(right.name))
  );
}

class DbmlNormalizer {
  readonly schema: SchemaDocument = {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public'],
    tables: [],
    enums: [],
  };
  private offset = 0;
  private object: QualifiedName | undefined;
  private count = 1;
  private readonly types = new Set<string>();
  private readonly relations = new Set<string>();
  private readonly tables = new Map<string, Table>();
  private readonly constraintNames = new Map<Table, Set<string>>();
  private readonly explicitNull = new Map<Table, Set<string>>();
  constructor(
    private source: DbmlSource,
    private maxObjects: number,
  ) {}
  fail(code: string, message: string): never {
    throw new DbmlFailure({
      code,
      severity: 'error',
      location: this.source.location(this.offset),
      message,
      ...(this.object ? { object: { ...this.object } } : {}),
    });
  }
  invalid(message: string): never {
    return this.fail('DBML_INVALID', message);
  }
  unsupported(message: string): never {
    return this.fail('DBML_UNSUPPORTED', message);
  }
  visit(node: Node): void {
    this.offset = this.source.index(node, this.offset);
  }
  add(): void {
    if (++this.count > this.maxObjects)
      this.fail('DBML_LIMIT', 'DBML object count limit exceeded; split the schema.');
  }
  fields(node: Node, allowed: string[]): void {
    for (const [key, value] of Object.entries(node)) {
      if (
        !allowed.includes(key) &&
        value !== undefined &&
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0)
      )
        this.unsupported(`Unsupported DBML detail ${key}; remove it or use supported SQL DDL.`);
    }
    if (node.metadata && Object.keys(record(node.metadata)).length)
      this.unsupported('Custom DBML metadata is not a supported physical schema setting.');
  }
  identifier(value: unknown): string {
    const name = text(value);
    if (!name.length || name.includes('\0') || Buffer.byteLength(name) > 63)
      this.invalid('PostgreSQL identifiers must contain 1–63 UTF-8 bytes without NUL.');
    return name;
  }
  qualified(node: Node, nameKey = 'name'): QualifiedName {
    return {
      schema: node.schemaName == null ? 'public' : this.identifier(node.schemaName),
      name: this.identifier(node[nameKey]),
    };
  }
  namespace(name: string): void {
    if (!this.schema.namespaces.includes(name)) {
      this.add();
      this.schema.namespaces.push(name);
    }
  }
  type(node: Node): DatabaseType {
    this.fields(node, ['type_name', 'schemaName', 'args']);
    const typeName = text(node.type_name);
    const qualified = this.qualified({ schemaName: node.schemaName, name: typeName });
    if (this.schema.enums.some((e) => id(e) === id(qualified))) {
      if (node.args) this.unsupported('Enum type modifiers are unsupported.');
      return { ...qualified, kind: 'enum', modifiers: [] };
    }
    if (node.schemaName != null && node.schemaName !== 'pg_catalog')
      this.unsupported(`Unknown PostgreSQL enum ${qualified.schema}.${qualified.name}.`);
    const match = /^([a-z][a-z0-9 ]*)(?:\(([^()]*)\))?$/i.exec(typeName);
    if (node.args != null && node.args !== match?.[2])
      throw new Error('DBML type arguments disagree with their source type name.');
    const alias = (match?.[1] ?? '').toLowerCase();
    const name = Object.hasOwn(aliases, alias) ? aliases[alias] : undefined;
    if (!name)
      this.unsupported(
        `Unsupported PostgreSQL type ${typeName}; use a supported scalar type or declare an enum.`,
      );
    if (node.schemaName === 'pg_catalog' && alias !== name)
      this.unsupported(
        'A pg_catalog-qualified type must use its physical PostgreSQL type name, not a SQL alias.',
      );
    const modifiers =
      match?.[2] === undefined
        ? []
        : (match[2] ?? '').split(',').map((v) => {
            if (!/^[+-]?\d+$/.test(v.trim())) this.invalid('Type modifiers must be integers.');
            const number = Number(v.trim());
            if (!Number.isSafeInteger(number))
              this.invalid('Type modifier exceeds the supported integer range.');
            return number;
          });
    if (['varchar', 'bpchar'].includes(name)) {
      if (modifiers.length > 1 || modifiers.some((n) => n < 1 || n > 10485760))
        this.invalid('Character length must be 1–10485760.');
      if (['char', 'character'].includes(alias) && modifiers.length === 0) modifiers.push(1);
    } else if (name === 'numeric') {
      if (
        modifiers.length > 2 ||
        (modifiers.length > 0 && ((modifiers[0] ?? 0) < 1 || (modifiers[0] ?? 0) > 1000)) ||
        (modifiers.length > 1 && Math.abs(modifiers[1] ?? 0) > 1000)
      )
        this.invalid('Numeric precision must be 1–1000 and scale -1000–1000.');
    } else if (['timestamp', 'timestamptz', 'time', 'timetz'].includes(name)) {
      if (modifiers.length > 1 || modifiers.some((n) => n < 0 || n > 6))
        this.invalid('Time precision must be 0–6.');
    } else if (modifiers.length) this.unsupported(`Modifiers on ${name} are unsupported.`);
    return { kind: 'builtin', schema: 'pg_catalog', name, modifiers };
  }
  default(node: Node): ColumnDefault {
    const value = record(node.dbdefault);
    switch (value.type) {
      case 'number':
        return { kind: 'literal', type: 'number', value: this.source.numericDefault(node) };
      case 'string':
        return { kind: 'literal', type: 'string', value: text(value.value) };
      case 'boolean':
        if (value.value === 'null') return { kind: 'literal', type: 'null', value: null };
        if (value.value === 'true' || value.value === 'false')
          return { kind: 'literal', type: 'boolean', value: value.value === 'true' };
        throw new Error('Unexpected DBML boolean token.');
      case 'expression': {
        const sql = text(value.value);
        if (!sql.trim()) this.invalid('A database default expression cannot be empty.');
        return { kind: 'expression', sql };
      }
      default:
        return this.unsupported('Unsupported DBML default category.');
    }
  }
  column(table: Table, name: string) {
    const column = table.columns.find((c) => c.name === name);
    if (!column) this.invalid(`Unknown column ${name}.`);
    return column;
  }
  key(table: Table, node: Node, columns: string[]): Key {
    this.add();
    if (!columns.length || new Set(columns).size !== columns.length)
      this.invalid('Key columns must be nonempty and distinct.');
    for (const name of columns) this.column(table, name);
    const key: Key = { columns: [...columns], location: this.source.location(this.offset) };
    if (node.name != null) {
      const name = this.identifier(node.name);
      const names = this.constraintNames.get(table);
      if (names?.has(name)) this.invalid(`Duplicate constraint name ${name}.`);
      names?.add(name);
      key.name = name;
    }
    return key;
  }
  btree(table: Table, key: Key): void {
    if (
      key.columns.some((name) => {
        const type = this.column(table, name).type;
        return type.kind === 'builtin' && type.name === 'json';
      })
    )
      this.invalid(
        'PostgreSQL json has no default btree comparison; use jsonb or a supported scalar column.',
      );
  }
  reserveRelation(value: QualifiedName): void {
    if (this.relations.has(id(value)))
      this.invalid(`Duplicate PostgreSQL relation ${value.schema}.${value.name}.`);
    this.relations.add(id(value));
  }
  primary(table: Table, node: Node, columns: string[]): void {
    if (table.primaryKey) this.invalid('Only one primary key is permitted per table.');
    const key = this.key(table, node, columns);
    this.btree(table, key);
    for (const column of key.columns) {
      if (this.explicitNull.get(table)?.has(column))
        this.invalid(`Primary key column ${column} cannot be explicitly NULL.`);
      this.column(table, column).nullable = false;
    }
    if (key.name) this.reserveRelation({ schema: table.schema, name: key.name });
    table.primaryKey = key;
  }
  unique(table: Table, node: Node, columns: string[]): void {
    const key = this.key(table, node, columns);
    this.btree(table, key);
    if (key.name) this.reserveRelation({ schema: table.schema, name: key.name });
    table.uniqueKeys.push(key);
  }
  table(node: Node): void {
    this.object = undefined;
    this.visit(node);
    this.add();
    this.fields(node, [
      'name',
      'schemaName',
      'alias',
      'fields',
      'indexes',
      'token',
      'headerColor',
      'note',
      'metadata',
    ]);
    const name = this.qualified(node);
    this.object = name;
    this.namespace(name.schema);
    if (this.types.has(id(name))) this.invalid('A table row type conflicts with an enum or table.');
    this.types.add(id(name));
    this.reserveRelation(name);
    const table: Table = {
      ...name,
      columns: [],
      uniqueKeys: [],
      foreignKeys: [],
      indexes: [],
      location: this.source.location(this.offset),
    };
    this.schema.tables.push(table);
    this.tables.set(id(name), table);
    this.constraintNames.set(table, new Set());
    this.explicitNull.set(table, new Set());
    const rawFields = list(node.fields);
    for (const field of rawFields) {
      this.visit(field);
      this.add();
      this.fields(field, [
        'name',
        'type',
        'pk',
        'unique',
        'not_null',
        'increment',
        'dbdefault',
        'note',
        'metadata',
        'inline_refs',
        'token',
      ]);
      if (field.increment)
        this.unsupported(
          'DBML increment does not distinguish PostgreSQL serial from identity; use SQL DDL with an explicit generation clause.',
        );
      const columnName = this.identifier(field.name);
      if (table.columns.some((c) => c.name === columnName))
        this.invalid(`Duplicate column ${columnName}.`);
      if (field.not_null === false) this.explicitNull.get(table)?.add(columnName);
      table.columns.push({
        name: columnName,
        type: this.type(record(field.type)),
        nullable: field.not_null !== true,
        ...(field.dbdefault ? { default: this.default(field) } : {}),
        location: this.source.location(this.offset),
      });
    }
    // The compiler folds multiple column-level pk flags into a synthetic composite index.
    const primaryFields = rawFields.filter((f) => f.pk === true);
    if (primaryFields.length) {
      this.visit(primaryFields[0] ?? node);
      this.primary(
        table,
        {},
        primaryFields.map((f) => text(f.name)),
      );
    }
    for (const field of rawFields)
      if (field.unique === true) {
        this.visit(field);
        this.unique(table, {}, [text(field.name)]);
      }
    for (const index of list(node.indexes)) {
      this.offset = this.source.index(index, this.source.index(node));
      this.fields(index, ['columns', 'name', 'pk', 'unique', 'type', 'note', 'token']);
      const columns = list(index.columns).map((entry) => {
        if (entry.type !== 'column')
          this.unsupported(
            'Expression indexes require SQL DDL; no expression is converted to a column.',
          );
        return this.identifier(entry.value);
      });
      if (index.type && index.type !== 'btree')
        this.unsupported('Only btree indexes are supported.');
      if (index.pk) this.primary(table, index, columns);
      else if (index.unique && !index.type) this.unique(table, index, columns);
      else {
        if (!index.name)
          this.unsupported('A physical non-constraint index requires an explicit name.');
        const key = this.key(table, index, columns);
        this.btree(table, key);
        const name = this.identifier(index.name);
        this.reserveRelation({ schema: table.schema, name });
        table.indexes.push({ ...key, name, unique: index.unique === true, method: 'btree' });
      }
    }
  }
  candidate(table: Table, columns: string[]): boolean {
    return [table.primaryKey, ...table.uniqueKeys, ...table.indexes.filter((i) => i.unique)].some(
      (key) => key && sameColumns(key.columns, columns),
    );
  }
  reference(node: Node): void {
    this.object = undefined;
    this.visit(node);
    this.fields(node, [
      'name',
      'schemaName',
      'endpoints',
      'onDelete',
      'onUpdate',
      'color',
      'token',
    ]);
    const endpoints = list(node.endpoints);
    if (endpoints.length !== 2) throw new Error('Expected two DBML reference endpoints.');
    const [first, second] = endpoints;
    if (!first || !second) throw new Error('Missing DBML endpoints.');
    if (first.relation === '*' && second.relation === '*')
      this.unsupported(
        'Many-to-many intent needs an explicit physical junction table with foreign keys.',
      );
    const oneToOne = first.relation === '1' && second.relation === '1';
    const localNode = oneToOne || second.relation === '*' ? second : first;
    const targetNode = localNode === first ? second : first;
    if (targetNode.relation !== '1' || !['1', '*'].includes(text(localNode.relation)))
      this.unsupported('Unsupported reference cardinality.');
    const localName = this.qualified(localNode, 'tableName');
    const targetName = this.qualified(targetNode, 'tableName');
    this.object = localName;
    const local = this.tables.get(id(localName));
    const target = this.tables.get(id(targetName));
    if (!local || !target)
      this.invalid('Foreign-key endpoint must name a declared physical table.');
    if (!Array.isArray(localNode.fieldNames) || !Array.isArray(targetNode.fieldNames))
      throw new Error('Missing reference field names.');
    const columns = localNode.fieldNames.map((name) => this.identifier(name));
    const targetColumns = targetNode.fieldNames.map((name) => this.identifier(name));
    const key = this.key(local, node, columns);
    if (
      !targetColumns.length ||
      columns.length !== targetColumns.length ||
      new Set(targetColumns).size !== targetColumns.length
    )
      this.invalid('Foreign-key column lists require equal nonzero arity and distinct columns.');
    for (const name of targetColumns) this.column(target, name);
    if (!this.candidate(target, targetColumns))
      this.invalid(
        'Foreign-key target requires an explicitly declared primary key, unique constraint or unique btree index.',
      );
    if (oneToOne && !this.candidate(local, columns))
      this.invalid(
        'One-to-one foreign-key columns require explicit uniqueness; add a primary or unique key.',
      );
    for (let i = 0; i < columns.length; i++) {
      if (
        !compatible(
          this.column(local, columns[i] ?? '').type,
          this.column(target, targetColumns[i] ?? '').type,
        )
      )
        this.invalid('Foreign-key types must be in supported compatible PostgreSQL type families.');
    }
    const action = (value: unknown): ReferentialAction => {
      if (value === undefined) return 'no action';
      if (!actions.has(text(value))) this.unsupported('Unsupported referential action.');
      return value as ReferentialAction;
    };
    const fk: ForeignKey = {
      ...key,
      target: targetName,
      targetColumns,
      onDelete: action(node.onDelete),
      onUpdate: action(node.onUpdate),
      match: 'simple',
      deferrable: false,
      initiallyDeferred: false,
    };
    local.foreignKeys.push(fk);
  }
  normalize(raw: Node): SchemaDocument {
    this.fields(raw, [
      'schemas',
      'tables',
      'notes',
      'refs',
      'enums',
      'tableGroups',
      'aliases',
      'token',
      'externals',
      'project',
    ]);
    const externals = record(raw.externals);
    for (const value of Object.values(externals))
      if (list(value).length)
        this.unsupported(
          'External DBML projects are unsupported; provide a self-contained schema.',
        );
    const project = record(raw.project ?? {});
    if (
      typeof project.database_type !== 'string' ||
      project.database_type.toLowerCase() !== 'postgresql'
    )
      this.fail(
        'DBML_DIALECT',
        "DBML requires Project database_type: 'PostgreSQL' matching target postgres.",
      );
    this.fields(project, [
      'name',
      'database_type',
      'note',
      'token',
      'enums',
      'refs',
      'tableGroups',
      'tables',
      'tablePartials',
    ]);
    for (const namespace of list(raw.schemas)) {
      this.visit(namespace);
      this.namespace(this.identifier(namespace.name));
    }
    const enums = list(raw.enums);
    // Register declarations before resolving forward enum references, retaining enum order.
    for (const node of enums) {
      this.object = undefined;
      this.visit(node);
      this.add();
      this.fields(node, ['name', 'schemaName', 'values', 'note', 'token']);
      const name = this.qualified(node);
      this.object = name;
      this.namespace(name.schema);
      if (this.types.has(id(name))) this.invalid('Duplicate enum type.');
      this.types.add(id(name));
      const values = list(node.values).map((value) => {
        this.add();
        this.fields(value, ['name', 'note', 'token']);
        const label = text(value.name);
        if (Buffer.byteLength(label) > 63)
          this.invalid('PostgreSQL enum labels may contain at most 63 UTF-8 bytes.');
        return label;
      });
      if (!values.length || new Set(values).size !== values.length)
        this.invalid('Enum labels must be nonempty and distinct.');
      this.schema.enums.push({ ...name, values, location: this.source.location(this.offset) });
    }
    for (const node of list(raw.tables)) this.table(node);
    for (const node of list(raw.refs)) this.reference(node);
    // Namespace order follows source declarations rather than the enum-registration pass.
    const declarations = [...enums, ...list(raw.tables), ...list(raw.schemas)].sort(
      (a, b) => this.source.index(a) - this.source.index(b),
    );
    const namespaces = ['public'];
    for (const node of declarations) {
      const name =
        node.schemaName == null
          ? list(raw.schemas).includes(node)
            ? text(node.name)
            : 'public'
          : text(node.schemaName);
      if (!namespaces.includes(name)) namespaces.push(name);
    }
    // raw.schemas is normally empty; preserve any explicitly registered namespace.
    for (const name of this.schema.namespaces)
      if (!namespaces.includes(name)) namespaces.push(name);
    this.schema.namespaces = namespaces;
    return this.schema;
  }
}

/** Direct, memory-only DBML normalization. No SQL export, database access or source execution. */
export function normalizeDbml(input: string, options: DbmlOptions): NormalizationResult {
  const error = (code: string, message: string): NormalizationResult => ({
    ok: false,
    diagnostics: [
      { code, severity: 'error', location: { offset: 0, line: 1, column: 1 }, message },
    ],
  });
  if (
    typeof input !== 'string' ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input) ||
    input.includes('\0') ||
    !options ||
    typeof options !== 'object' ||
    options.target !== 'postgres'
  )
    return error(
      'DBML_OPTIONS',
      'Use well-formed Unicode DBML without NUL and an explicit postgres target.',
    );
  const maxInputBytes = options.maxInputBytes ?? 1048576;
  const maxObjects = options.maxObjects ?? 10000;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes < 1 ||
    maxInputBytes > 8388608 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 100000
  )
    return error(
      'DBML_OPTIONS',
      'Input limits must be positive integers: at most 8 MiB and 100,000 objects.',
    );
  if (Buffer.byteLength(input) > maxInputBytes)
    return error('DBML_LIMIT', 'DBML input exceeds maxInputBytes; split the schema.');
  let source: DbmlSource | undefined;
  try {
    source = new DbmlSource(input, maxObjects);
    const raw = record(parseDbml(input));
    const schema = new DbmlNormalizer(source, maxObjects).normalize(raw);
    return { ok: true, schema, diagnostics: [] };
  } catch (cause) {
    if (cause instanceof DbmlFailure) return { ok: false, diagnostics: [cause.diagnostic] };
    if (
      cause &&
      typeof cause === 'object' &&
      'diags' in cause &&
      Array.isArray(cause.diags) &&
      cause.diags.length
    ) {
      const diagnostics = cause.diags.map((entry: unknown) => {
        const node = record(entry);
        const location = record(record(node.location).start);
        return {
          code: 'DBML_SYNTAX',
          severity: 'error' as const,
          message: text(node.message),
          location: source?.location(source.atPosition(location.line, location.column)) ?? {
            offset: 0,
            line: 1,
            column: 1,
          },
        };
      });
      return { ok: false, diagnostics };
    }
    return error(
      'DBML_PARSER',
      `DBML parser contract failure: ${cause instanceof Error ? cause.message : 'unknown error'}. Report the input with the pinned parser version.`,
    );
  }
}
