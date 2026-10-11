export interface SourceLocation {
  /** Zero-based UTF-8 byte offset; line and column are one-based. */
  offset: number;
  line: number;
  column: number;
}

export interface QualifiedName {
  schema: string;
  name: string;
}

export interface Diagnostic {
  code: string;
  severity: 'error';
  location: SourceLocation;
  message: string;
  object?: QualifiedName;
}

export type ColumnDefault =
  | { kind: 'literal'; type: 'string'; value: string }
  | { kind: 'literal'; type: 'number'; value: string }
  | { kind: 'literal'; type: 'boolean'; value: boolean }
  | { kind: 'literal'; type: 'null'; value: null }
  | { kind: 'expression'; sql: string };

export interface DatabaseType extends QualifiedName {
  kind: 'builtin' | 'enum';
  modifiers: number[];
}

export interface Column {
  name: string;
  type: DatabaseType;
  nullable: boolean;
  default?: ColumnDefault;
  generation?: { kind: 'identity'; strategy: 'always' | 'by-default' };
  location: SourceLocation;
}

export interface Key {
  name?: string;
  columns: string[];
  location: SourceLocation;
}

export type ReferentialAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface ForeignKey extends Key {
  target: QualifiedName;
  targetColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  match: 'simple' | 'full';
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface Index extends Key {
  name: string;
  unique: boolean;
  method: 'btree';
}

export interface Table extends QualifiedName {
  columns: Column[];
  primaryKey?: Key;
  uniqueKeys: Key[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
  location: SourceLocation;
}

export interface DatabaseEnum extends QualifiedName {
  values: string[];
  location: SourceLocation;
}

export interface SchemaDocument {
  version: 1;
  dialect: 'postgres';
  namespaces: string[];
  tables: Table[];
  enums: DatabaseEnum[];
}

export type NormalizationResult =
  | { ok: true; schema: SchemaDocument; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };

export interface PostgresOptions {
  dialect: 'postgres';
  target: 'postgres';
  /** Default 1 MiB; at most 8 MiB. */
  maxInputBytes?: number;
  /** Statements, namespaces, types, tables, columns, constraints and indexes. Default 10,000. */
  maxObjects?: number;
}

export interface DbmlOptions {
  target: 'postgres';
  /** Default 1 MiB; at most 8 MiB. */
  maxInputBytes?: number;
  /** Namespaces, enums and labels, tables, columns, keys, indexes and references. Default 10,000. */
  maxObjects?: number;
}
