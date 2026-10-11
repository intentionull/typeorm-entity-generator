# DBML normalization

The internal synchronous `normalizeDbml(input, options)` adapter maps a bounded PostgreSQL DBML subset directly into the version-1 [schema contract](../src/schema/model.ts). It uses the pinned `@dbml/core` v2 compiler output, not SQL export or SQL-to-DBML conversion. It performs no filesystem access, source execution, database connection, or entity emission. This is an internal implementation, not a published package API.

Require both `options.target: 'postgres'` and a matching project declaration:

```dbml
Project schema {
  database_type: 'PostgreSQL'
}

Table accounts {
  id uuid [pk]
  email varchar(255) [not null, unique]
  active boolean [not null, default: true]
}
```

Missing or conflicting engines fail; neither the table names nor type spellings select an engine implicitly. Aurora PostgreSQL deployment compatibility is not established by these normalization tests.

## Supported physical subset

| Feature | Rules |
| --- | --- |
| Tables and namespaces | Default `public`; explicit schema qualification; forward enum/reference declarations; source order retained within tables, enums, and references |
| Names | Preserve case and decoded quoted names; no singularization, case folding, or generated collision suffixes; PostgreSQL identifiers must contain 1–63 UTF-8 bytes without NUL |
| Table aliases | Resolve references to physical table names; aliases do not rename output schema facts |
| Columns | Preserve declaration order; omitted nullability means nullable; primary keys force non-nullability and reject explicitly nullable columns |
| Scalar types | Integer families, boolean, text/varchar/char, numeric/decimal, UUID, JSON/JSONB, date/time/timestamp families, real/double precision, bytea; SQL aliases map to catalog names |
| Modifiers | Character length 1–10,485,760; numeric precision 1–1,000 and scale -1,000–1,000; time precision 0–6; no arbitrary type arguments |
| Enums | Declared schema-qualified types and decoded labels; label order retained, distinct labels required, at most 63 UTF-8 bytes per label; empty individual labels are allowed |
| Defaults | Distinguish string, boolean, null, number, and database expression; recover numeric spelling from source rather than rounded JavaScript values; expressions remain unevaluated text |
| Primary keys | Column flags or explicit indexes, including composite keys; multiple primary keys fail |
| Unique constraints | Column `unique` or an untyped `unique` index, including composite constraints |
| Physical indexes | Named simple-column btree indexes; explicitly typed unique btree indexes stay indexes rather than becoming constraints |
| Foreign keys | Inline or standalone `>`/`<`, composite pairs and self-references; require declared target candidate keys, matching arity, distinct columns, and compatible supported type families |
| One-to-one | `-` requires explicit uniqueness on both endpoints; no inferred keys. Standalone references make the second endpoint the foreign-key side; inline references keep the declaring column as that side |
| Referential actions | `no action`, `restrict`, `cascade`, `set null`, `set default`; unspecified actions become `no action`; simple match and nondeferrable behavior |

Type spelling is deliberately bounded. Use `timestamptz(3)` rather than `"timestamp(3) with time zone"`, and `varchar(20)` rather than `"varchar (20)"`. Quote supported multiword type names, such as `"double precision"`. A `pg_catalog` qualification requires the physical catalog type name, such as `pg_catalog.int4`, not `pg_catalog.integer`. `char` and `character` without a length map to length one; bare `bpchar` retains no explicit modifier. A single numeric precision stays a single modifier, matching the SQL contract.

The pinned parser rejects leading-dot numeric defaults such as `.125`; use `0.125`. Keep standalone composite reference settings on the relationship line rather than a separate line. These parser boundaries have [retained negative fixtures](../tests/fixtures/regressions/README.md); accepted numeric spelling is still preserved exactly.

Foreign-key compatibility covers identical types, integer-family pairs, and text/varchar pairs. This is bounded structural validation, not PostgreSQL execution or validation of every value/default. Built-in `json` cannot be a primary key, unique constraint, or simple btree index; `jsonb` and enums named `json` are not subject to that restriction. Named constraints/indexes must not collide with other declared relations in their namespace; unnamed constraints remain unnamed.

Notes, header colors, reference colors, standalone notes, and table groupings are presentation-only and are not copied into physical schema facts. Other physical settings are not silently discarded.

## Unsupported or ambiguous details

- `increment`: DBML does not distinguish PostgreSQL serial from identity generation. Use SQL DDL with an explicit generation clause.
- Many-to-many intent without a physical junction table: declare that table and its foreign keys.
- Checks, expression indexes, non-btree indexes, arrays, domains, serial types, unknown scalar types, and unsupported modifiers: use supported SQL DDL or extend the adapter with independent tests.
- Unnamed non-constraint indexes: provide an explicit physical name.
- Table partials, records/data payloads, dependencies, external projects, inactive references, and custom physical metadata: remove them or supply a supported self-contained input. Some forms are rejected by the pinned parser before adapter validation.

No constraint, junction table, generation strategy, or application persistence cascade is inferred. Parser acceptance is not evidence that the adapter supports a feature. The [upstream corpus](../tests/fixtures/README.md) remains a parser/provenance corpus; successful parsing there does not promise successful normalization.

## Limits and diagnostics

The default input limit is 1 MiB; callers may set `maxInputBytes` up to 8 MiB. The default `maxObjects` is 10,000, configurable up to 100,000. Counted objects include the initial public namespace, other namespaces, enums and labels, tables, columns, keys/indexes, and foreign keys. Presentation-only objects do not consume this structural budget, but their source still consumes byte/token limits.

Before invoking the compiler, a source scan enforces nesting of at most 64 levels and at most `maxObjects * 32 + 1024` lexical tokens. Quoted values and comments are opaque to this scan. Reject malformed Unicode and embedded NUL before parsing. These limits bound accepted inputs; they are not a process-isolation or hard execution-time guarantee.

Failures return diagnostics without a partial schema:

| Code | Meaning |
| --- | --- |
| `DBML_OPTIONS` | Invalid input encoding, target, or limits |
| `DBML_LIMIT` | Input bytes, structural count, nesting, or token budget exceeded |
| `DBML_DIALECT` | Missing or conflicting PostgreSQL project declaration |
| `DBML_SYNTAX` | Source scan or compiler syntax diagnostics |
| `DBML_UNSUPPORTED` | Parsed semantics outside the supported subset |
| `DBML_INVALID` | Invalid PostgreSQL structural facts in the supported subset |
| `DBML_PARSER` | Unexpected upstream/runtime contract failure; report a synthetic reproduction and pinned parser version |

Locations use zero-based UTF-8 byte offsets and one-based line/column positions. Columns count JavaScript UTF-16 code units. The compiler's synthetic composite primary-key token has offset `-1`; its diagnostic/key location falls back to the owning table. Root/option diagnostics use offset 0, line 1, column 1. Named physical objects are attached where available.

## Verification and extension

Run `npm run test:dbml` for all compiled DBML semantic suites, or `npm run check` for the contributor gate. The [coverage matrix](dbml-coverage.md) maps the documented profile to independent physical facts and expected rejections. Tests compare the basic, tenant, and quoted SQL/DBML pairs; five locally authored application examples against handwritten complete-schema oracles; all 25 update/delete combinations on nullable composite circular cross-schema references; fixed-seed escaped identifiers, defaults, ordering and collisions; and exact resource boundaries. Schema results own their state; mutating a returned result cannot change subsequent calls. Line/branch coverage alone does not establish semantic completeness.

The upstream declarations pull optional editor modules into strict compilation. The adapter therefore validates a narrow runtime parser boundary and treats raw data as `unknown`; it does not disable library checking or add editor dependencies. Parser updates must review that boundary, source token behavior, numeric defaults, synthetic keys, and semantic regressions.

Database catalog comparison, generated TypeORM consumers, NestJS persistence, CLI output safety, and public packaging remain separate milestones in the [implementation plan](implementation-plan.md).
