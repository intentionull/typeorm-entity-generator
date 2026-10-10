import type {
  Diagnostic,
  QualifiedName,
  SchemaDocument,
  SourceLocation,
  Table,
} from '../schema/model.js';
import type {
  ColumnNamingOverride,
  NamingOptions,
  NamingResult,
  ResolvedEntityName,
  TableNamingOverride,
} from './model.js';

const reserved = new Set([
  'abstract',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'global',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'override',
  'package',
  'private',
  'protected',
  'prototype',
  'public',
  'readonly',
  'require',
  'return',
  'satisfies',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'using',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'arguments',
  '__proto__',
]);

const rootLocation: SourceLocation = { offset: 0, line: 1, column: 1 };
type Report = (code: string, message: string, table?: Table, location?: SourceLocation) => void;
const identity = (name: QualifiedName): string => JSON.stringify([name.schema, name.name]);
const describe = (name: QualifiedName): string =>
  `${JSON.stringify(name.schema)}.${JSON.stringify(name.name)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function qualified(value: unknown): value is QualifiedName {
  return (
    isObject(value) &&
    onlyKeys(value, ['schema', 'name']) &&
    typeof value.schema === 'string' &&
    value.schema.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0
  );
}

function readOverrides(
  document: SchemaDocument,
  input: unknown,
  report: Report,
): Map<string, TableNamingOverride> {
  const overrides = new Map<string, TableNamingOverride>();
  if (
    !isObject(input) ||
    !onlyKeys(input, ['tables']) ||
    ('tables' in input && !Array.isArray(input.tables))
  ) {
    report(
      'NAME_OPTIONS',
      'Naming options must be a declarative object with an optional tables array; unknown fields are not allowed.',
    );
    return overrides;
  }
  const tables = new Map(document.tables.map((table) => [identity(table), table]));
  for (const [index, value] of ((input.tables as unknown[] | undefined) ?? []).entries()) {
    if (
      !isObject(value) ||
      !onlyKeys(value, ['table', 'className', 'fileName', 'columns']) ||
      !qualified(value.table)
    ) {
      report(
        'NAME_OPTIONS',
        `tables[${index}] must select an exact { schema, name } table and contain only className, fileName, and columns overrides.`,
      );
      continue;
    }
    const table = tables.get(identity(value.table));
    if (
      ('className' in value && typeof value.className !== 'string') ||
      ('fileName' in value && typeof value.fileName !== 'string') ||
      ('columns' in value && !Array.isArray(value.columns))
    ) {
      report(
        'NAME_OPTIONS',
        `Overrides for ${describe(value.table)} require string names and an optional columns array.`,
        table,
      );
      continue;
    }
    const columns: ColumnNamingOverride[] = [];
    let valid = true;
    for (const [columnIndex, column] of (
      (value.columns as unknown[] | undefined) ?? []
    ).entries()) {
      if (
        !isObject(column) ||
        !onlyKeys(column, ['column', 'propertyName']) ||
        typeof column.column !== 'string' ||
        column.column.length === 0 ||
        typeof column.propertyName !== 'string'
      ) {
        report(
          'NAME_OPTIONS',
          `columns[${columnIndex}] for ${describe(value.table)} requires exact column and propertyName strings; unknown fields are not allowed.`,
          table,
        );
        valid = false;
      } else {
        columns.push({ column: column.column, propertyName: column.propertyName });
      }
    }
    if (!valid) continue;
    if (!table) {
      report(
        'NAME_OVERRIDE',
        `Override selects unknown table ${describe(value.table)}; use exact physical schema and table names.`,
      );
      continue;
    }
    const key = identity(table);
    if (overrides.has(key)) {
      report(
        'NAME_OVERRIDE',
        `Duplicate override for table ${describe(table)}; combine it into one entry.`,
        table,
      );
      continue;
    }
    const knownColumns = new Map(table.columns.map((column) => [column.name, column]));
    const seen = new Set<string>();
    for (const column of columns) {
      const source = knownColumns.get(column.column);
      if (!source) {
        report(
          'NAME_OVERRIDE',
          `Override selects unknown column ${JSON.stringify(column.column)} in ${describe(table)}; use its exact physical name.`,
          table,
        );
      } else if (seen.has(column.column)) {
        report(
          'NAME_OVERRIDE',
          `Duplicate override for column ${JSON.stringify(column.column)} in ${describe(table)}.`,
          table,
          source.location,
        );
      }
      seen.add(column.column);
    }
    const entry: TableNamingOverride = {
      table: { schema: table.schema, name: table.name },
      columns,
    };
    if (typeof value.className === 'string') entry.className = value.className;
    if (typeof value.fileName === 'string') entry.fileName = value.fileName;
    overrides.set(key, entry);
  }
  return overrides;
}

function words(name: string): string[] {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function defaultIdentifier(name: string, kind: 'class' | 'property'): string {
  if (!/^[\x20-\x7E]*$/.test(name)) return '';
  return words(name)
    .map((word, index) =>
      kind === 'property' && index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
}

function validIdentifier(name: string): boolean {
  return name.length <= 128 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !reserved.has(name);
}

function validFileName(name: string): boolean {
  return (
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.entity\.ts$/.test(name) &&
    !name.includes('..') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

/** Resolve normalized schema names without I/O, inference, or changes to database semantics. */
export function resolveNames(document: SchemaDocument, options: NamingOptions = {}): NamingResult {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (code, message, table, location) => {
    const diagnostic: Diagnostic = {
      code,
      severity: 'error',
      location: { ...(location ?? table?.location ?? rootLocation) },
      message,
    };
    if (table) diagnostic.object = { schema: table.schema, name: table.name };
    diagnostics.push(diagnostic);
  };
  const overrides = readOverrides(document, options, report);
  if (diagnostics.length) return { ok: false, diagnostics };

  const entities: ResolvedEntityName[] = [];
  const classes = new Map<string, Table>();
  const files = new Map<string, Table>();
  for (const table of document.tables) {
    const override = overrides.get(identity(table));
    const className = override?.className ?? defaultIdentifier(table.name, 'class');
    const fileName = override?.fileName ?? `${words(className).join('-')}.entity.ts`;
    if (!validIdentifier(className)) {
      report(
        'NAME_INVALID',
        `Invalid entity class name ${JSON.stringify(className)} for ${describe(table)}; provide a nonreserved ASCII className identifier of at most 128 characters.`,
        table,
      );
    } else {
      const previous = classes.get(className);
      if (previous) {
        report(
          'NAME_COLLISION',
          `Entity class name ${JSON.stringify(className)} is shared by ${describe(previous)} and ${describe(table)}; override className explicitly.`,
          table,
        );
      } else classes.set(className, table);
    }
    if (!validFileName(fileName)) {
      report(
        'NAME_INVALID',
        `Invalid filename ${JSON.stringify(fileName)} for ${describe(table)}; provide a portable single fileName ending in .entity.ts, at most 200 characters, without traversal or device names.`,
        table,
      );
    } else {
      const key = fileName.toLowerCase();
      const previous = files.get(key);
      if (previous) {
        report(
          'NAME_COLLISION',
          `Entity filename ${JSON.stringify(fileName)} conflicts with ${describe(previous)} on case-insensitive filesystems; override fileName or className explicitly.`,
          table,
        );
      } else files.set(key, table);
    }
    const columnOverrides = new Map(
      override?.columns?.map((column) => [column.column, column.propertyName]) ?? [],
    );
    const properties = new Map<string, string>();
    const entity: ResolvedEntityName = {
      table: { schema: table.schema, name: table.name },
      className,
      fileName,
      columns: [],
    };
    for (const column of table.columns) {
      const propertyName =
        columnOverrides.get(column.name) ?? defaultIdentifier(column.name, 'property');
      if (!validIdentifier(propertyName)) {
        report(
          'NAME_INVALID',
          `Invalid property name ${JSON.stringify(propertyName)} for column ${JSON.stringify(column.name)} in ${describe(table)}; provide a nonreserved ASCII propertyName identifier of at most 128 characters.`,
          table,
          column.location,
        );
      } else {
        const previous = properties.get(propertyName);
        if (previous !== undefined) {
          report(
            'NAME_COLLISION',
            `Property name ${JSON.stringify(propertyName)} is shared by columns ${JSON.stringify(previous)} and ${JSON.stringify(column.name)} in ${describe(table)}; override propertyName explicitly.`,
            table,
            column.location,
          );
        } else properties.set(propertyName, column.name);
      }
      entity.columns.push({ columnName: column.name, propertyName });
    }
    entities.push(entity);
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, resolved: { schema: structuredClone(document), entities }, diagnostics: [] };
}
