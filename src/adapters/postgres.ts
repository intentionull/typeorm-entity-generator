import { parse, scan } from 'libpg-query';
import type {
  Column,
  ColumnDefault,
  DatabaseType,
  Diagnostic,
  ForeignKey,
  Key,
  NormalizationResult,
  PostgresOptions,
  QualifiedName,
  ReferentialAction,
  SchemaDocument,
  Table,
} from '../schema/model.js';
import {
  identity,
  list,
  literal,
  nodeOffset,
  record,
  Source,
  stringList,
  text,
} from './postgres-ast.js';
import type { Ast } from './postgres-ast.js';

const builtins = new Set([
  'int2',
  'int4',
  'int8',
  'bool',
  'text',
  'varchar',
  'bpchar',
  'numeric',
  'uuid',
  'json',
  'jsonb',
  'date',
  'timestamp',
  'timestamptz',
  'time',
  'timetz',
  'float4',
  'float8',
  'bytea',
]);
const integers = new Set(['int2', 'int4', 'int8']);
const actions: Record<string, ReferentialAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

class Rejection extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

class Interpreter {
  readonly schema: SchemaDocument = {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public'],
    tables: [],
    enums: [],
  };
  readonly relations = new Set<string>();
  readonly explicitNull = new WeakSet<Column>();
  readonly constraintNames = new WeakMap<Table, Set<string>>();
  offset = 0;
  object: QualifiedName | undefined;
  objects = 0;
  constructor(
    readonly source: Source,
    readonly maxObjects: number,
  ) {}
  fail(code: string, message: string, offset = this.offset): never {
    throw new Rejection({
      code,
      severity: 'error',
      location: this.source.location(offset),
      message,
      ...(this.object ? { object: { ...this.object } } : {}),
    });
  }
  unsupported(message: string): never {
    return this.fail(
      'SQL_UNSUPPORTED',
      `${message} Use the supported PostgreSQL subset documented in docs/postgres-normalization.md.`,
    );
  }
  invalid(message: string): never {
    return this.fail('SCHEMA_INVALID', message);
  }
  count(): void {
    if (++this.objects > this.maxObjects)
      this.fail(
        'SQL_LIMIT',
        `Schema exceeds maxObjects (${this.maxObjects}). Split the schema or explicitly raise the limit.`,
      );
  }
  fields(node: Ast, allowed: string[]): void {
    for (const key of Object.keys(node))
      if (key !== 'location' && !allowed.includes(key))
        this.unsupported(`Unsupported PostgreSQL field: ${key}.`);
  }
  qualified(value: unknown): QualifiedName {
    const node = record(value);
    this.fields(node, ['relname', 'schemaname', 'inh', 'relpersistence']);
    if (node.relpersistence !== 'p' || node.inh !== true)
      this.unsupported('Temporary/unlogged relations and ONLY references are not supported.');
    return {
      schema: typeof node.schemaname === 'string' ? node.schemaname : 'public',
      name: text(node.relname),
    };
  }
  namespace(name: string): void {
    if (!this.schema.namespaces.includes(name))
      this.invalid(`Namespace ${name} must be declared before use.`);
  }
  table(name: QualifiedName): Table {
    const table = this.schema.tables.find((t) => t.schema === name.schema && t.name === name.name);
    if (!table)
      this.invalid(
        `Table ${name.schema}.${name.name} must be declared before use; add forward/cyclic foreign keys with ALTER TABLE after both tables exist.`,
      );
    return table;
  }
  column(table: Table, name: string): Column {
    const column = table.columns.find((c) => c.name === name);
    if (!column) this.invalid(`Column ${table.schema}.${table.name}.${name} does not exist.`);
    return column;
  }
  reserveRelation(name: QualifiedName): void {
    const key = identity(name.schema, name.name);
    if (this.relations.has(key)) this.invalid(`Duplicate relation ${name.schema}.${name.name}.`);
    this.relations.add(key);
  }
  type(value: unknown): DatabaseType {
    const node = record(value);
    this.fields(node, ['names', 'typemod', 'typmods']);
    const names = stringList(node.names);
    if (names.length < 1 || names.length > 2)
      this.unsupported('Types must be unqualified or schema-qualified.');
    const name = names[names.length - 1];
    if (!name) this.unsupported('Empty type name.');
    const namespace = names.length === 2 ? names[0] : builtins.has(name) ? 'pg_catalog' : 'public';
    if (!namespace) this.unsupported('Empty type namespace.');
    const modifiers = list(node.typmods).map((v) => {
      const constant = literal(v);
      if (
        !constant ||
        constant.kind !== 'literal' ||
        constant.type !== 'number' ||
        !Number.isSafeInteger(Number(constant.value))
      )
        this.unsupported('Type modifiers must be integer constants.');
      return Number(constant.value);
    });
    if (namespace === 'pg_catalog' && builtins.has(name)) {
      const maxMods =
        name === 'numeric'
          ? 2
          : ['varchar', 'bpchar', 'timestamp', 'timestamptz', 'time', 'timetz'].includes(name)
            ? 1
            : 0;
      if (modifiers.length > maxMods) this.invalid(`Invalid modifiers for ${name}.`);
      const [first, second] = modifiers;
      if (first !== undefined) {
        if (
          name === 'numeric' &&
          (first < 1 || first > 1000 || (second !== undefined && (second < -1000 || second > 1000)))
        )
          this.invalid('numeric precision must be 1..1000 and scale -1000..1000.');
        if (['varchar', 'bpchar'].includes(name) && (first < 1 || first > 10485760))
          this.invalid('Character length must be 1..10485760.');
        if (
          ['timestamp', 'timestamptz', 'time', 'timetz'].includes(name) &&
          (first < 0 || first > 6)
        )
          this.invalid('Time precision must be 0..6.');
      }
      return { kind: 'builtin', schema: namespace, name, modifiers };
    }
    const enumeration = this.schema.enums.find((e) => e.schema === namespace && e.name === name);
    if (!enumeration)
      this.unsupported(
        `Unsupported or undeclared type ${namespace}.${name}. For serial columns, use explicit integer identity columns.`,
      );
    if (modifiers.length) this.invalid('Enum types do not accept modifiers.');
    return { kind: 'enum', schema: namespace, name, modifiers };
  }
  default(value: unknown, offset: number): ColumnDefault {
    const node = record(value);
    const simple = literal(node);
    if (simple) return simple;
    if (node.TypeCast) {
      const cast = record(node.TypeCast);
      this.fields(cast, ['arg', 'typeName']);
      this.type(cast.typeName);
      this.default(cast.arg, offset);
    } else if (node.FuncCall) {
      const call = record(node.FuncCall);
      this.fields(call, ['funcname', 'funcformat', 'args']);
      const names = stringList(call.funcname);
      const name = names.at(-1);
      if (
        names.length > 2 ||
        (names.length === 2 && names[0] !== 'pg_catalog') ||
        !['now', 'gen_random_uuid'].includes(name ?? '') ||
        list(call.args).length
      )
        this.unsupported(
          'Only zero-argument now() and gen_random_uuid() function defaults are supported.',
        );
    } else if (node.SQLValueFunction) {
      const expression = record(node.SQLValueFunction);
      this.fields(expression, ['op', 'typmod']);
      if (
        ![
          'SVFOP_CURRENT_DATE',
          'SVFOP_CURRENT_TIME',
          'SVFOP_CURRENT_TIME_N',
          'SVFOP_CURRENT_TIMESTAMP',
          'SVFOP_CURRENT_TIMESTAMP_N',
          'SVFOP_LOCALTIME',
          'SVFOP_LOCALTIME_N',
          'SVFOP_LOCALTIMESTAMP',
          'SVFOP_LOCALTIMESTAMP_N',
        ].includes(text(expression.op))
      )
        this.unsupported('Unsupported SQL value function default.');
      if (
        typeof expression.typmod === 'number' &&
        (expression.typmod < -1 || expression.typmod > 6)
      )
        this.invalid('Default time precision must be 0..6.');
    } else
      this.unsupported(
        'Unsupported default expression; literals, casts and the documented time/UUID defaults are supported.',
      );
    return { kind: 'expression', sql: this.source.defaultText(offset) };
  }
  addColumn(table: Table, value: unknown): { constraint: Ast; column: Column }[] {
    this.count();
    const node = record(value);
    this.offset = nodeOffset(node, this.offset);
    this.fields(node, ['colname', 'typeName', 'is_local', 'constraints']);
    const name = text(node.colname);
    if (table.columns.some((c) => c.name === name)) this.invalid(`Duplicate column ${name}.`);
    const column: Column = {
      name,
      type: this.type(node.typeName),
      nullable: true,
      location: this.source.location(this.offset),
    };
    table.columns.push(column);
    return list(node.constraints).map((v) => ({
      constraint: record(record(v).Constraint),
      column,
    }));
  }
  namedKey(table: Table, node: Ast, columns: string[]): Key {
    if (!columns.length || new Set(columns).size !== columns.length)
      this.invalid('Keys require a nonempty list of distinct columns.');
    for (const name of columns) this.column(table, name);
    const key: Key = { columns, location: this.source.location(this.offset) };
    if (typeof node.conname === 'string') {
      const names = this.constraintNames.get(table) ?? new Set<string>();
      if (names.has(node.conname)) this.invalid(`Duplicate constraint ${node.conname}.`);
      names.add(node.conname);
      this.constraintNames.set(table, names);
      key.name = node.conname;
    }
    return key;
  }
  btreeColumns(table: Table, columns: string[]): void {
    for (const name of columns) {
      const type = this.column(table, name).type;
      if (type.kind === 'builtin' && type.name === 'json')
        this.invalid(
          'PostgreSQL json has no default btree comparison operators; choose jsonb or index a supported scalar column.',
        );
    }
  }
  constraint(table: Table, node: Ast, column?: Column): void {
    this.count();
    this.offset = nodeOffset(node, this.offset);
    const kind = text(node.contype);
    this.fields(node, [
      'contype',
      'conname',
      'keys',
      'fk_attrs',
      'pk_attrs',
      'pktable',
      'fk_matchtype',
      'fk_upd_action',
      'fk_del_action',
      'is_enforced',
      'initially_valid',
      'deferrable',
      'initdeferred',
      'raw_expr',
      'generated_when',
    ]);
    if (node.is_enforced === false || node.initially_valid === false)
      this.unsupported('NOT VALID and NOT ENFORCED constraints are unsupported.');
    if ((node.deferrable || node.initdeferred) && kind !== 'CONSTR_FOREIGN')
      this.unsupported('Deferred non-foreign-key constraints are unsupported.');
    const columns = column
      ? [column.name]
      : stringList(kind === 'CONSTR_FOREIGN' ? node.fk_attrs : node.keys);
    switch (kind) {
      case 'CONSTR_NULL':
      case 'CONSTR_NOTNULL': {
        if (!column || node.conname)
          this.unsupported('Named/table-level nullability constraints are unsupported.');
        if (kind === 'CONSTR_NULL') {
          if (!column.nullable)
            this.invalid(`Conflicting NULL and NOT NULL constraints on ${column.name}.`);
          this.explicitNull.add(column);
        } else {
          if (this.explicitNull.has(column))
            this.invalid(`Conflicting NULL and NOT NULL constraints on ${column.name}.`);
          column.nullable = false;
        }
        break;
      }
      case 'CONSTR_DEFAULT':
        if (!column || column.default || column.generation)
          this.invalid('A column can have only one default or identity generation.');
        if (node.conname) this.unsupported('Named defaults are unsupported.');
        column.default = this.default(node.raw_expr, this.offset);
        break;
      case 'CONSTR_IDENTITY':
        if (!column || column.default || column.generation || this.explicitNull.has(column))
          this.invalid(
            'Identity requires a single generation clause and no explicit NULL or default.',
          );
        if (!integers.has(column.type.name) || column.type.kind !== 'builtin')
          this.invalid('Identity requires a smallint, integer or bigint column.');
        if (node.conname) this.unsupported('Named identity clauses are unsupported.');
        if (!['a', 'd'].includes(text(node.generated_when)))
          this.unsupported('Unknown identity generation strategy.');
        column.generation = {
          kind: 'identity',
          strategy: node.generated_when === 'a' ? 'always' : 'by-default',
        };
        column.nullable = false;
        break;
      case 'CONSTR_PRIMARY': {
        if (table.primaryKey) this.invalid('Only one primary key is permitted per table.');
        const key = this.namedKey(table, node, columns);
        this.btreeColumns(table, columns);
        for (const name of columns) {
          const col = this.column(table, name);
          if (this.explicitNull.has(col))
            this.invalid(`Primary key column ${name} cannot be explicitly NULL.`);
          col.nullable = false;
        }
        if (key.name) this.reserveRelation({ schema: table.schema, name: key.name });
        table.primaryKey = key;
        break;
      }
      case 'CONSTR_UNIQUE': {
        const key = this.namedKey(table, node, columns);
        this.btreeColumns(table, columns);
        if (key.name) this.reserveRelation({ schema: table.schema, name: key.name });
        table.uniqueKeys.push(key);
        break;
      }
      case 'CONSTR_FOREIGN': {
        const key = this.namedKey(table, node, columns);
        const targetName = this.qualified(node.pktable);
        const target = this.table(targetName);
        const targetColumns = node.pk_attrs
          ? stringList(node.pk_attrs)
          : (target.primaryKey?.columns.slice() ?? []);
        if (
          columns.length !== targetColumns.length ||
          !targetColumns.length ||
          new Set(targetColumns).size !== targetColumns.length
        )
          this.invalid(
            'Foreign-key column lists must have equal nonzero arity and distinct columns.',
          );
        for (const name of targetColumns) this.column(target, name);
        const candidates = [
          target.primaryKey,
          ...target.uniqueKeys,
          ...target.indexes.filter((i) => i.unique),
        ];
        if (
          !candidates.some(
            (k) =>
              k &&
              k.columns.length === targetColumns.length &&
              k.columns.every((c) => targetColumns.includes(c)),
          )
        )
          this.invalid(
            'Foreign-key target columns require an existing primary key, unique constraint or simple unique index.',
          );
        for (let i = 0; i < columns.length; i++) {
          const localName = columns[i];
          const remoteName = targetColumns[i];
          if (!localName || !remoteName) this.invalid('Invalid foreign-key arity.');
          const local = this.column(table, localName).type;
          const remote = this.column(target, remoteName).type;
          const identical =
            local.kind === remote.kind &&
            local.schema === remote.schema &&
            local.name === remote.name;
          const integerPair =
            local.kind === 'builtin' &&
            remote.kind === 'builtin' &&
            integers.has(local.name) &&
            integers.has(remote.name);
          const textPair =
            local.kind === 'builtin' &&
            remote.kind === 'builtin' &&
            ['text', 'varchar'].includes(local.name) &&
            ['text', 'varchar'].includes(remote.name);
          if (!identical && !integerPair && !textPair)
            this.invalid(
              'Foreign-key column types are not in the supported compatible type families.',
            );
        }
        const onDelete = actions[text(node.fk_del_action)];
        const onUpdate = actions[text(node.fk_upd_action)];
        if (!onDelete || !onUpdate || !['s', 'f'].includes(text(node.fk_matchtype)))
          this.unsupported('Unsupported referential action or match mode.');
        const fk: ForeignKey = {
          ...key,
          target: targetName,
          targetColumns,
          onDelete,
          onUpdate,
          match: node.fk_matchtype === 'f' ? 'full' : 'simple',
          deferrable: node.deferrable === true,
          initiallyDeferred: node.initdeferred === true,
        };
        table.foreignKeys.push(fk);
        break;
      }
      default:
        this.unsupported(`Unsupported constraint ${kind}.`);
    }
  }
  create(node: Ast): void {
    this.object = this.qualified(node.relation);
    this.fields(node, ['relation', 'tableElts', 'oncommit']);
    if (node.oncommit !== 'ONCOMMIT_NOOP')
      this.unsupported('ON COMMIT table behavior is unsupported.');
    this.namespace(this.object.schema);
    if (
      this.schema.enums.some((e) => e.schema === this.object?.schema && e.name === this.object.name)
    )
      this.invalid('Tables and enum types share a type namespace.');
    this.reserveRelation(this.object);
    const table: Table = {
      ...this.object,
      columns: [],
      uniqueKeys: [],
      foreignKeys: [],
      indexes: [],
      location: this.source.location(this.offset),
    };
    this.schema.tables.push(table);
    const pending: { constraint: Ast; column?: Column }[] = [];
    for (const element of list(node.tableElts)) {
      const item = record(element);
      if (item.ColumnDef) pending.push(...this.addColumn(table, item.ColumnDef));
      else if (item.Constraint) pending.push({ constraint: record(item.Constraint) });
      else this.unsupported('Unsupported table element.');
    }
    // PostgreSQL resolves self-references after this table's columns and candidate keys exist.
    for (const item of pending.filter((p) => p.constraint.contype !== 'CONSTR_FOREIGN'))
      this.constraint(table, item.constraint, item.column);
    for (const item of pending.filter((p) => p.constraint.contype === 'CONSTR_FOREIGN'))
      this.constraint(table, item.constraint, item.column);
    for (const column of table.columns) this.explicitNull.delete(column);
  }
  alter(node: Ast): void {
    this.object = this.qualified(node.relation);
    this.fields(node, ['relation', 'cmds', 'objtype']);
    if (node.objtype !== 'OBJECT_TABLE')
      this.unsupported('Only ordinary ALTER TABLE is supported.');
    const table = this.table(this.object);
    for (const command of list(node.cmds)) {
      this.count();
      const cmd = record(record(command).AlterTableCmd);
      this.offset = nodeOffset(cmd, this.offset);
      this.fields(cmd, ['subtype', 'name', 'def', 'behavior']);
      switch (cmd.subtype) {
        case 'AT_AddColumn': {
          const pending = this.addColumn(table, record(cmd.def).ColumnDef);
          for (const item of pending) this.constraint(table, item.constraint, item.column);
          for (const item of pending) this.explicitNull.delete(item.column);
          break;
        }
        case 'AT_AddConstraint':
          this.constraint(table, record(record(cmd.def).Constraint));
          break;
        case 'AT_SetNotNull': {
          const column = this.column(table, text(cmd.name));
          column.nullable = false;
          this.explicitNull.delete(column);
          break;
        }
        case 'AT_DropNotNull': {
          const column = this.column(table, text(cmd.name));
          if (table.primaryKey?.columns.includes(column.name) || column.generation)
            this.invalid('Cannot drop NOT NULL from a primary-key or identity column.');
          column.nullable = true;
          this.explicitNull.delete(column);
          break;
        }
        case 'AT_ColumnDefault': {
          const column = this.column(table, text(cmd.name));
          if (column.generation) this.invalid('Cannot change the default of an identity column.');
          if (cmd.def) column.default = this.default(cmd.def, nodeOffset(cmd.def, this.offset));
          else delete column.default;
          break;
        }
        default:
          this.unsupported(`Unsupported ALTER TABLE operation ${String(cmd.subtype)}.`);
      }
    }
  }
  index(node: Ast): void {
    this.object = this.qualified(node.relation);
    this.fields(node, ['idxname', 'relation', 'accessMethod', 'indexParams', 'unique']);
    if (node.accessMethod !== 'btree' || typeof node.idxname !== 'string')
      this.unsupported('Only explicitly named simple btree indexes are supported.');
    const table = this.table(this.object);
    const columns = list(node.indexParams).map((v) => {
      const item = record(record(v).IndexElem);
      this.fields(item, ['name', 'ordering', 'nulls_ordering']);
      if (
        item.ordering !== 'SORTBY_DEFAULT' ||
        item.nulls_ordering !== 'SORTBY_NULLS_DEFAULT' ||
        typeof item.name !== 'string'
      )
        this.unsupported('Index expressions, ordering and null placement are unsupported.');
      return item.name;
    });
    const key = this.namedKey(table, {}, columns);
    this.btreeColumns(table, columns);
    this.reserveRelation({ schema: table.schema, name: node.idxname });
    table.indexes.push({
      ...key,
      name: node.idxname,
      method: 'btree',
      unique: node.unique === true,
    });
  }
  statement(value: unknown): void {
    this.count();
    const entry = record(value);
    this.offset = typeof entry.stmt_location === 'number' ? entry.stmt_location : 0;
    this.object = undefined;
    const statement = record(entry.stmt);
    const kind = Object.keys(statement)[0];
    if (!kind) this.unsupported('Empty statement.');
    const node = record(statement[kind]);
    this.offset = nodeOffset(node, this.offset);
    switch (kind) {
      case 'CreateSchemaStmt': {
        this.fields(node, ['schemaname']);
        const name = text(node.schemaname);
        if (name.startsWith('pg_') || this.schema.namespaces.includes(name))
          this.invalid(`Duplicate or reserved namespace ${name}.`);
        this.schema.namespaces.push(name);
        break;
      }
      case 'CreateEnumStmt': {
        this.fields(node, ['typeName', 'vals']);
        const names = stringList(node.typeName);
        if (!names.length || names.length > 2)
          this.unsupported('Enum types must be unqualified or schema-qualified.');
        const name = names.at(-1);
        const namespace = names.length === 2 ? names[0] : 'public';
        if (!name || !namespace) this.invalid('Invalid enum name.');
        this.object = { schema: namespace, name };
        this.namespace(namespace);
        if (
          this.schema.enums.some((e) => e.schema === namespace && e.name === name) ||
          this.schema.tables.some((t) => t.schema === namespace && t.name === name)
        )
          this.invalid(`Duplicate type ${namespace}.${name}.`);
        const values = stringList(node.vals);
        if (new Set(values).size !== values.length || values.some((v) => Buffer.byteLength(v) > 63))
          this.invalid('Enum labels must be distinct and at most 63 UTF-8 bytes.');
        this.schema.enums.push({
          ...this.object,
          values,
          location: this.source.location(this.offset),
        });
        break;
      }
      case 'CreateStmt':
        this.create(node);
        break;
      case 'AlterTableStmt':
        this.alter(node);
        break;
      case 'IndexStmt':
        this.index(node);
        break;
      default:
        this.unsupported(`Unsupported PostgreSQL statement ${kind}. No SQL is executed.`);
    }
  }
}

/** Parse and normalize an allowlisted PostgreSQL DDL document without executing it. */
export async function normalizePostgres(
  sql: string,
  options: PostgresOptions,
): Promise<NormalizationResult> {
  const simpleError = (code: string, message: string): NormalizationResult => ({
    ok: false,
    diagnostics: [
      { code, severity: 'error', location: { offset: 0, line: 1, column: 1 }, message },
    ],
  });
  if (!options || options.dialect !== 'postgres' || options.target !== 'postgres')
    return simpleError(
      'SQL_DIALECT',
      'SQL dialect and target must both be postgres; cross-database translation is not supported.',
    );
  const maxBytes = options.maxInputBytes ?? 1048576;
  const maxObjects = options.maxObjects ?? 10000;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 8388608 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 50000
  )
    return simpleError(
      'SQL_OPTIONS',
      'Limits must be positive integers: maxInputBytes <= 8388608 and maxObjects <= 50000.',
    );
  if (typeof sql !== 'string') return simpleError('SQL_OPTIONS', 'SQL input must be a string.');
  if (Buffer.byteLength(sql) > maxBytes)
    return simpleError(
      'SQL_LIMIT',
      `Input exceeds maxInputBytes (${maxBytes}). Split the schema or explicitly raise the limit.`,
    );
  if (sql.includes('\0') || Buffer.from(sql).toString('utf8') !== sql)
    return simpleError(
      'SQL_OPTIONS',
      'SQL must contain well-formed Unicode and no NUL bytes; these can change or truncate parser input.',
    );
  let interpreter: Interpreter | undefined;
  try {
    const scanned = await scan(sql);
    const source = new Source(sql, scanned.tokens);
    interpreter = new Interpreter(source, maxObjects);
    let depth = 0;
    for (const token of scanned.tokens) {
      if (/^U&"/i.test(token.text))
        interpreter.fail(
          'SQL_UNSUPPORTED',
          'Unicode escape identifiers are unsupported; use ordinary UTF-8 quoted identifiers.',
          token.start,
        );
      if (token.text === '(' || token.text === '[') depth++;
      if (token.text === ')' || token.text === ']') depth--;
      if (depth > 64) interpreter.fail('SQL_LIMIT', 'SQL nesting exceeds 64 levels.', token.start);
      if (token.tokenName === 'IDENT') {
        const name = token.text.startsWith('"')
          ? token.text.slice(1, -1).replaceAll('""', '"')
          : token.text;
        if (Buffer.byteLength(name) > 63)
          interpreter.fail(
            'SQL_UNSUPPORTED',
            'Identifiers longer than 63 UTF-8 bytes are rejected rather than silently truncated.',
            token.start,
          );
      }
    }
    const parsed = await parse(sql);
    for (const entry of list(parsed.stmts)) interpreter.statement(entry);
    return { ok: true, schema: interpreter.schema, diagnostics: [] };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, diagnostics: [error.diagnostic] };
    if (error instanceof Error && 'sqlDetails' in error) {
      const details = record(error.sqlDetails);
      const cursor = typeof details.cursorPosition === 'number' ? details.cursorPosition : 1;
      const offset = Buffer.byteLength([...sql].slice(0, Math.max(0, cursor - 1)).join(''));
      return {
        ok: false,
        diagnostics: [
          {
            code: 'SQL_PARSE',
            severity: 'error',
            location: new Source(sql, []).location(offset),
            message: error.message,
          },
        ],
      };
    }
    return simpleError(
      'SQL_PARSER',
      `PostgreSQL parser contract failure: ${error instanceof Error ? error.message : 'unknown error'}. Report this input with the pinned parser version.`,
    );
  }
}
