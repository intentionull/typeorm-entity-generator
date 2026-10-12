import { IndentationText, NewLineKind, Project, QuoteKind } from 'ts-morph';
import type { ResolvedEntityName, ResolvedSchema } from '../resolve/model.js';
import { resolveNames } from '../resolve/names.js';
import type { Column, Diagnostic, ForeignKey, QualifiedName, Table } from '../schema/model.js';
import type { EmissionResult, PlannedFile } from './model.js';

const key = (name: QualifiedName): string => JSON.stringify([name.schema, name.name]);
const literal = (value: string): string =>
  JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const sameColumns = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((name) => right.includes(name));

function sameType(left: Column, right: Column): boolean {
  return (
    left.type.kind === right.type.kind &&
    left.type.schema === right.type.schema &&
    left.type.name === right.type.name &&
    left.type.modifiers.length === right.type.modifiers.length &&
    left.type.modifiers.every((value, index) => value === right.type.modifiers[index])
  );
}

function defaultSql(column: Column): string | undefined {
  const value = column.default;
  if (!value) return undefined;
  if (value.kind === 'expression') return value.sql;
  if (value.type === 'string') return `'${value.value.replaceAll("'", "''")}'`;
  if (value.type === 'number') return value.value;
  if (value.type === 'boolean') return value.value ? 'true' : 'false';
  return 'NULL';
}

function propertyType(column: Column, document: ResolvedSchema, buffer: string): string {
  let type: string;
  if (column.type.kind === 'enum') {
    const definition = document.schema.enums.find((item) => key(item) === key(column.type))!;
    type = definition.values.map(literal).join(' | ');
  } else {
    switch (column.type.name) {
      case 'int2':
      case 'int4':
      case 'float4':
      case 'float8':
        type = 'number';
        break;
      case 'bool':
        type = 'boolean';
        break;
      case 'timestamp':
      case 'timestamptz':
        type = 'Date';
        break;
      case 'json':
      case 'jsonb':
        type = 'unknown';
        break;
      case 'bytea':
        type = buffer;
        break;
      default:
        type = 'string';
    }
  }
  return column.nullable && type !== 'unknown' ? `${type} | null` : type;
}

function columnOptions(column: Column, table: Table, resolved: ResolvedSchema): string {
  const physicalType = column.type.name === 'bpchar' ? 'character' : column.type.name;
  const options = [
    `name: ${literal(column.name)}`,
    `type: ${literal(column.type.kind === 'enum' ? 'enum' : physicalType)}`,
  ];
  if (!column.generation) options.push(`nullable: ${column.nullable}`);
  const modifiers = column.type.modifiers;
  if (['varchar', 'bpchar'].includes(column.type.name) && modifiers.length) {
    options.push(`length: ${literal(String(modifiers[0]))}`);
  } else if (column.type.name === 'numeric' && modifiers.length) {
    options.push(`precision: ${modifiers[0]}`);
    if (modifiers.length > 1) options.push(`scale: ${modifiers[1]}`);
  } else if (modifiers.length) {
    options.push(`precision: ${modifiers[0]}`);
  }
  if (column.type.kind === 'enum') {
    const definition = resolved.schema.enums.find((item) => key(item) === key(column.type))!;
    options.push(
      `enum: [${definition.values.map(literal).join(', ')}]`,
      `enumName: ${literal(definition.name)}`,
    );
  }
  if (table.primaryKey?.columns.includes(column.name) && table.primaryKey.name) {
    options.push(`primaryKeyConstraintName: ${literal(table.primaryKey.name)}`);
  }
  if (column.generation) {
    options.push(
      `generatedIdentity: ${literal(column.generation.strategy === 'always' ? 'ALWAYS' : 'BY DEFAULT')}`,
    );
  }
  const sql = defaultSql(column);
  if (sql !== undefined) options.push(`default: () => ${literal(sql)}`);
  return `{ ${options.join(', ')} }`;
}

/** Internal PostgreSQL / TypeORM 1.x profile. Input comes from normalization and naming. */
export function emitPostgresEntities(resolved: ResolvedSchema): EmissionResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, message: string, table: Table, location = table.location): void => {
    diagnostics.push({
      code,
      severity: 'error',
      message,
      location: { ...location },
      object: { schema: table.schema, name: table.name },
    });
  };
  const { schema, entities } = resolved;
  const names = resolveNames(schema, {
    tables: entities.map((entity) => ({
      table: entity.table,
      className: entity.className,
      fileName: entity.fileName,
      columns: entity.columns.map((column) => ({
        column: column.columnName,
        propertyName: column.propertyName,
      })),
    })),
  });
  if (!names.ok)
    return {
      ok: false,
      diagnostics: names.diagnostics.map((item) => ({ ...item, code: 'EMIT_INVALID' })),
    };
  for (const expected of names.resolved.entities) {
    const actual = entities.find((entity) => key(entity.table) === key(expected.table));
    if (
      !actual ||
      actual.columns.length !== expected.columns.length ||
      expected.columns.some(
        (column) =>
          !actual.columns.some(
            (item) =>
              item.columnName === column.columnName && item.propertyName === column.propertyName,
          ),
      )
    ) {
      diagnostics.push({
        code: 'EMIT_INVALID',
        severity: 'error',
        message: 'Entity mappings must include every physical table and column exactly once.',
        location: { offset: 0, line: 1, column: 1 },
      });
    }
  }
  if (
    entities.length !== schema.tables.length ||
    schema.version !== 1 ||
    schema.dialect !== 'postgres'
  ) {
    diagnostics.push({
      code: 'EMIT_INVALID',
      severity: 'error',
      message: 'Expected complete version-1 PostgreSQL naming mappings.',
      location: { offset: 0, line: 1, column: 1 },
    });
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const entityByTable = new Map(entities.map((entity) => [key(entity.table), entity]));
  const tableByName = new Map(schema.tables.map((table) => [key(table), table]));
  for (const table of schema.tables) {
    const entity = entityByTable.get(key(table))!;
    if (entity.className === 'entities') {
      report(
        'EMIT_COLLISION',
        'Class name entities conflicts with the registry export; provide a class naming override.',
        table,
      );
    }
    if (!table.primaryKey)
      report(
        'EMIT_UNSUPPORTED',
        'TypeORM entities require an explicitly declared primary key.',
        table,
      );
    else if (
      table.columns
        .filter((column) => table.primaryKey!.columns.includes(column.name))
        .some((column, index) => column.name !== table.primaryKey!.columns[index])
    ) {
      report(
        'EMIT_UNSUPPORTED',
        'TypeORM cannot preserve primary key order independently of physical column order.',
        table,
        table.primaryKey.location,
      );
    }
    const physicalNames = [
      table.schema,
      table.name,
      ...table.columns.map((column) => column.name),
      table.primaryKey?.name,
      ...table.uniqueKeys.map((item) => item.name),
      ...table.indexes.map((item) => item.name),
      ...table.foreignKeys.map((item) => item.name),
    ].filter((name): name is string => name !== undefined);
    if (physicalNames.some((name) => /[."\\]/.test(name)))
      report(
        'EMIT_UNSUPPORTED',
        'This profile cannot safely represent an identifier containing a dot, quote or backslash.',
        table,
      );
    for (const column of table.columns) {
      if (
        column.type.kind === 'builtin' &&
        column.type.name === 'bpchar' &&
        column.type.modifiers.length === 0
      ) {
        report(
          'EMIT_UNSUPPORTED',
          'Unbounded bpchar cannot be represented without narrowing its length.',
          table,
          column.location,
        );
      }
      if (column.generation && !table.primaryKey?.columns.includes(column.name)) {
        report(
          'EMIT_UNSUPPORTED',
          'Non-primary identity columns are not representable by this decorated profile.',
          table,
          column.location,
        );
      }
      if (column.type.kind === 'enum' && column.type.schema !== table.schema) {
        report(
          'EMIT_UNSUPPORTED',
          'TypeORM cannot preserve a cross-schema enum reference in this profile.',
          table,
          column.location,
        );
      }
    }
    for (const [index, foreignKey] of table.foreignKeys.entries()) {
      const target = tableByName.get(key(foreignKey.target));
      if (!target) {
        report('EMIT_INVALID', 'Missing foreign-key target.', table, foreignKey.location);
        continue;
      }
      if (foreignKey.match === 'full')
        report(
          'EMIT_UNSUPPORTED',
          'TypeORM cannot preserve MATCH FULL.',
          table,
          foreignKey.location,
        );
      if (foreignKey.onDelete === 'set default' || foreignKey.onUpdate === 'set default')
        report(
          'EMIT_UNSUPPORTED',
          'SET DEFAULT is not accepted by the pinned TypeORM foreign-key option types; this profile does not replace it with DEFAULT or suppress type checking.',
          table,
          foreignKey.location,
        );
      if (
        foreignKey.columns.some((name, position) => {
          const local = table.columns.find((column) => column.name === name);
          const remote = target.columns.find(
            (column) => column.name === foreignKey.targetColumns[position],
          );
          return !local || !remote || !sameType(local, remote);
        })
      )
        report(
          'EMIT_UNSUPPORTED',
          'Relation columns must have identical physical type and modifiers; TypeORM otherwise changes scalar metadata.',
          table,
          foreignKey.location,
        );
      if (entity.columns.some((column) => column.propertyName === `relation${index + 1}`)) {
        report(
          'EMIT_COLLISION',
          `Generated relation${index + 1} conflicts with a scalar property; override that scalar property name.`,
          table,
          foreignKey.location,
        );
      }
    }
  }
  for (const definition of schema.enums) {
    const owner = schema.tables.find((table) =>
      table.columns.some(
        (column) => column.type.kind === 'enum' && key(column.type) === key(definition),
      ),
    );
    if (!owner || /[."\\]/.test(definition.name)) {
      diagnostics.push({
        code: 'EMIT_UNSUPPORTED',
        severity: 'error',
        message:
          'Unused enums and enum identifiers containing dots, quotes or backslashes cannot be emitted.',
        location: { ...definition.location },
        object: { schema: definition.schema, name: definition.name },
      });
    }
  }
  for (const namespace of schema.namespaces) {
    if (namespace !== 'public' && !schema.tables.some((table) => table.schema === namespace)) {
      diagnostics.push({
        code: 'EMIT_UNSUPPORTED',
        severity: 'error',
        message: `Unused namespace ${namespace} cannot be represented by entity metadata.`,
        location: { offset: 0, line: 1, column: 1 },
      });
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };

  const project = new Project({
    useInMemoryFileSystem: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Single,
      indentationText: IndentationText.TwoSpaces,
      newLineKind: NewLineKind.LineFeed,
    },
  });
  const files: PlannedFile[] = [];
  for (const table of schema.tables) {
    const entity = entityByTable.get(key(table))!;
    const source = project.createSourceFile(entity.fileName, '');
    const occupied = new Set([entity.className]);
    const symbol = (base: string): string => {
      let name = base;
      while (occupied.has(name)) name += '_';
      occupied.add(name);
      return name;
    };
    const orm = symbol('$orm');
    source.addImportDeclaration({ moduleSpecifier: 'typeorm', namespaceImport: orm });
    const buffer = symbol('$Buffer');
    if (
      table.columns.some((column) => column.type.name === 'bytea' && column.type.kind === 'builtin')
    ) {
      source.addImportDeclaration({
        moduleSpecifier: 'node:buffer',
        isTypeOnly: true,
        namedImports: [{ name: 'Buffer', alias: buffer }],
      });
    }
    const targets = new Map<string, string>([[key(table), entity.className]]);
    for (const foreignKey of table.foreignKeys) {
      if (targets.has(key(foreignKey.target))) continue;
      const target = entityByTable.get(key(foreignKey.target))!;
      const alias = symbol(`$Target${targets.size}`);
      targets.set(key(foreignKey.target), alias);
      source.addImportDeclaration({
        moduleSpecifier: `./${target.fileName.slice(0, -3)}.js`,
        namedImports: [{ name: target.className, alias }],
      });
    }
    const property = (mapping: ResolvedEntityName, name: string): string =>
      mapping.columns.find((column) => column.columnName === name)!.propertyName;
    const entityClass = source.addClass({ name: entity.className, isExported: true });
    entityClass.addDecorator({
      name: `${orm}.Entity`,
      arguments: [`{ name: ${literal(table.name)}, schema: ${literal(table.schema)} }`],
    });
    for (const unique of table.uniqueKeys) {
      const columns = `[${unique.columns.map((name) => literal(property(entity, name))).join(', ')}]`;
      entityClass.addDecorator({
        name: `${orm}.Unique`,
        arguments: unique.name ? [literal(unique.name), columns] : [columns],
      });
    }
    for (const index of table.indexes) {
      entityClass.addDecorator({
        name: `${orm}.Index`,
        arguments: [
          literal(index.name),
          `[${index.columns.map((name) => literal(property(entity, name))).join(', ')}]`,
          `{ unique: ${index.unique} }`,
        ],
      });
    }
    for (const foreignKey of table.foreignKeys) {
      const target = entityByTable.get(key(foreignKey.target))!;
      const options = foreignKeyOptions(foreignKey);
      entityClass.addDecorator({
        name: `${orm}.ForeignKey`,
        arguments: [
          `() => ${targets.get(key(foreignKey.target))}`,
          `[${foreignKey.columns.map((name) => literal(property(entity, name))).join(', ')}]`,
          `[${foreignKey.targetColumns.map((name) => literal(property(target, name))).join(', ')}]`,
          options,
        ],
      });
    }
    for (const column of table.columns) {
      const decorator = column.generation
        ? 'PrimaryGeneratedColumn'
        : table.primaryKey!.columns.includes(column.name)
          ? 'PrimaryColumn'
          : 'Column';
      entityClass.addProperty({
        name: property(entity, column.name),
        type: propertyType(column, resolved, buffer),
        hasExclamationToken: true,
        decorators: [
          {
            name: `${orm}.${decorator}`,
            arguments: column.generation
              ? [literal('identity'), columnOptions(column, table, resolved)]
              : [columnOptions(column, table, resolved)],
          },
        ],
      });
    }
    for (const [index, foreignKey] of table.foreignKeys.entries()) {
      const target = targets.get(key(foreignKey.target))!;
      const nullable = foreignKey.columns.some(
        (name) => table.columns.find((column) => column.name === name)!.nullable,
      );
      const unique = [
        table.primaryKey!,
        ...table.uniqueKeys,
        ...table.indexes.filter((item) => item.unique),
      ].some((item) => sameColumns(item.columns, foreignKey.columns));
      const targetMapping = entityByTable.get(key(foreignKey.target))!;
      entityClass.addProperty({
        name: `relation${index + 1}`,
        type: `${orm}.Relation<${target}>${nullable ? ' | null' : ''}`,
        hasExclamationToken: true,
        decorators: [
          {
            name: `${orm}.${unique ? 'OneToOne' : 'ManyToOne'}`,
            arguments: [
              `() => ${target}`,
              `{ nullable: ${nullable}, cascade: false, eager: false, lazy: false, createForeignKeyConstraints: false }`,
            ],
          },
          {
            name: `${orm}.JoinColumn`,
            arguments: [
              `[${foreignKey.columns.map((name, position) => `{ name: ${literal(name)}, referencedColumnName: ${literal(property(targetMapping, foreignKey.targetColumns[position]!))} }`).join(', ')}]`,
            ],
          },
        ],
      });
    }
    files.push({ path: entity.fileName, content: source.getFullText() });
  }
  const registry = project.createSourceFile('index.ts', '');
  for (const [index, entity] of entities.entries()) {
    registry.addImportDeclaration({
      moduleSpecifier: `./${entity.fileName.slice(0, -3)}.js`,
      namedImports: [{ name: entity.className, alias: `$Entity${index}` }],
    });
    registry.addExportDeclaration({
      moduleSpecifier: `./${entity.fileName.slice(0, -3)}.js`,
      namedExports: [entity.className],
    });
  }
  registry.addStatements(
    `export const entities = [${entities.map((_, index) => `$Entity${index}`).join(', ')}];`,
  );
  files.push({ path: 'index.ts', content: registry.getFullText() });
  return { ok: true, files, diagnostics: [] };
}

function foreignKeyOptions(foreignKey: ForeignKey): string {
  const options = [
    `onDelete: ${literal(foreignKey.onDelete.toUpperCase())}`,
    `onUpdate: ${literal(foreignKey.onUpdate.toUpperCase())}`,
  ];
  if (foreignKey.name) options.push(`name: ${literal(foreignKey.name)}`);
  if (foreignKey.deferrable)
    options.push(
      `deferrable: ${literal(foreignKey.initiallyDeferred ? 'INITIALLY DEFERRED' : 'INITIALLY IMMEDIATE')}`,
    );
  return `{ ${options.join(', ')} }`;
}
