import type { Diagnostic, QualifiedName, SchemaDocument } from '../schema/model.js';

export interface ColumnNamingOverride {
  /** Exact physical column name, not a generated property name. */
  column: string;
  propertyName: string;
}

export interface TableNamingOverride {
  /** Exact physical schema and table name; no dotted-name shorthand. */
  table: QualifiedName;
  className?: string;
  /** A single portable basename ending in .entity.ts. */
  fileName?: string;
  columns?: ColumnNamingOverride[];
}

export interface NamingOptions {
  tables?: TableNamingOverride[];
}

export interface ResolvedColumnName {
  columnName: string;
  propertyName: string;
}

export interface ResolvedEntityName {
  table: QualifiedName;
  className: string;
  fileName: string;
  columns: ResolvedColumnName[];
}

export interface ResolvedSchema {
  /** Independent copy; physical schema facts are unchanged. */
  schema: SchemaDocument;
  entities: ResolvedEntityName[];
}

export type NamingResult =
  | { ok: true; resolved: ResolvedSchema; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };
