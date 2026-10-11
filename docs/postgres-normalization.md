# PostgreSQL normalization

**Status:** an internal, tested PostgreSQL DDL adapter. It does not generate entities. There is no public package entry point or CLI yet. The package remains private.

`src/adapters/postgres.ts` exports `normalizePostgres(sql, options)` for internal development. It uses the pinned `libpg-query` parser and an allowlisted interpreter; it never executes SQL, connects to a database, or runs application code. SQL dialect and target must both be `postgres`. Cross-database translation is not supported.

The version-1 contract lives in `src/schema/model.ts`. A successful result contains physical schema names, ordered tables and columns, canonical database types and modifiers, literal/expression defaults, identity strategies, keys, foreign keys, indexes, and source locations. A rejected result contains diagnostics and **no partial schema**. Contract changes remain internal until the public API is designed.

## Supported subset and evidence

Tests assert independently chosen schema facts, not snapshots of parser output. All references below are to [compiled normalization tests](../tests/postgres.test.ts), with source inputs in the [fixture pairs](../tests/fixtures/pairs/).

| Operation or feature | Boundary | Evidence |
| --- | --- | --- |
| Empty input and comments | Empty schema with implicit `public` namespace | `normalization has no shared schema state across concurrent or failed calls` |
| `CREATE SCHEMA` | Explicit name; no authorization or embedded statements; reserved `pg_` namespaces rejected | Tenant fixture; `qualified same-name tables stay distinct and all builtin aliases normalize consistently` |
| `CREATE TYPE ... AS ENUM` | Ordered, distinct labels; namespace must already exist; enum must precede its use | Tenant fixture; invalid enum/type cases |
| `CREATE TABLE` | Ordinary persistent tables; physical quoted names preserved; no inheritance, partitioning, table options, or `IF NOT EXISTS` | Basic, tenant, and quoted fixtures; unsupported-feature cases |
| Scalar columns | Builtin types listed below, or a previously declared enum | Basic and tenant fixtures; builtin-alias test; unknown-type rejection |
| Nullability | Column `NULL`/`NOT NULL`; primary keys and identity imply non-nullability; no named/table-level nullability constraints | Basic and quoted fixtures; conflicting-nullability cases; explicit-NULL/ALTER regression |
| Literal defaults | Strings, booleans, null, and decimal numeric text; zero and empty strings remain present | Basic fixture; literal-default test |
| Expression defaults | Casts of supported defaults, `now()`, `gen_random_uuid()`, and current/local date/time expressions; temporal precision 0–6 | Default-expression tests and scanner-boundary regression |
| Identity columns | Integer `GENERATED ALWAYS` or `BY DEFAULT AS IDENTITY`; no sequence options, explicit default, or explicit `NULL` | Identity test; unsupported sequence-option and invalid identity cases |
| Primary and unique keys | Ordered, distinct column lists; optional physical constraint names; no deferred unique/primary keys or `NULLS NOT DISTINCT` | Basic/tenant fixtures; duplicate key and index-name collision cases |
| Foreign keys | Explicit or omitted target columns; omitted columns resolve to the target primary key; ordered pairs; previously available target table/key or a same-table candidate key | Tenant/quoted fixtures; self-reference, uniqueness, arity, missing-target, and source-order tests |
| Referential actions | `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL`, `SET DEFAULT`; `MATCH SIMPLE`/`FULL`; optional deferrability | Foreign-key semantics test; unsupported column-list actions |
| `CREATE [UNIQUE] INDEX` | Explicit name, plain columns, btree, default ordering/null placement; no expression, predicate, include list, opclass, or concurrent build | Quoted fixture; unique-index target test; unsupported-index cases |
| `ALTER TABLE ... ADD COLUMN` | Same column subset as `CREATE TABLE`; no `IF NOT EXISTS` | Selected-ALTER test; explicit-NULL regression |
| `ALTER TABLE ... ADD CONSTRAINT` | Supported primary, unique, or foreign key | Selected-ALTER and source-order tests |
| `ALTER TABLE ... ALTER COLUMN` | Set/drop default; set/drop `NOT NULL`; cannot remove identity/primary-key non-nullability or change identity defaults | Selected-ALTER test and invalid identity/primary-key cases |

Source order is authoritative. Forward table, enum, and candidate-key references fail rather than being repaired. Columns in a newly created table are collected before its keys; candidate keys are resolved before same-table foreign keys. External schema objects are not assumed to exist. Unqualified table and enum names resolve to `public`; an explicit `SET search_path` is rejected.

Builtin canonical names are `int2`, `int4`, `int8`, `bool`, `text`, `varchar`, `bpchar`, `numeric`, `float4`, `float8`, `uuid`, `date`, `timestamp`, `timestamptz`, `time`, `timetz`, `json`, `jsonb`, and `bytea`. Standard parser-resolved aliases are accepted. Character lengths must be 1–10,485,760; numeric precision 1–1000 and scale −1000–1000; temporal precision 0–6. Omitted modifiers remain omitted. `serial` types are rejected until their sequence semantics are modeled. Plain `json` cannot form a btree key/index; it is not silently changed to `jsonb`.

Foreign-key type checks accept identical types, integer-family pairs, and text-family pairs. They are structural checks, not a simulation of PostgreSQL operator-family or implicit-cast resolution. Unique-index target matching compares column sets, while preserving the declared order of foreign-key pairs. Unnamed constraints remain unnamed; server-generated constraint/index names are not invented. Persistence cascades are not inferred from database referential actions.

## Rejections and diagnostics

Unsupported statements, types, or active AST fields stop normalization. Examples include `DROP`, data writes, arbitrary function definitions/default calls, comments as schema statements, dump/session directives, arrays, domains, extensions, collations, stored/virtual generated expressions, checks, partitioning, row security, partial/expression indexes, renames, and type changes. See the table-driven unsupported cases in the test suite. Parser grammar acceptance is not adapter support.

| Code | Meaning |
| --- | --- |
| `SQL_DIALECT` | SQL dialect and target do not both select PostgreSQL |
| `SQL_OPTIONS` | Invalid limit options, non-string input, NUL bytes, or malformed Unicode |
| `SQL_LIMIT` | Input bytes, interpreter work budget, or scanner nesting limit exceeded |
| `SQL_PARSE` | Parser/scanner syntax failure |
| `SQL_UNSUPPORTED` | Feature outside the allowlist; includes overlong and Unicode-escape identifiers |
| `SCHEMA_INVALID` | A detected structural conflict, invalid modifier, or invalid key/reference |
| `SQL_PARSER` | Unexpected parser contract; report the input and pinned parser version |

Diagnostics identify the statement, clause, or token; they do not promise exact ranges for every AST node. Offsets are zero-based UTF-8 bytes. Lines and Unicode-code-point columns are one-based. Results are deterministic for the same input and options. Only the first error is returned; there is no writable or best-effort result after rejection.

## Resource and input policy

- `maxInputBytes`: default 1 MiB; configurable from 1 byte to 8 MiB.
- `maxObjects`: default 10,000; configurable from 1 to 50,000. This is an interpreter work budget counting statements, ALTER commands, columns, and constraints, not a table-count limit. Namespace, enum, table, and index declarations consume their statement entry; nested elements add work.
- Scanner nesting is limited to 64 levels before grammar parsing. Input/option limits are checked before scanning. The work budget is enforced **after** parsing; it does not bound parser memory or provide cancellation.
- Identifiers above 63 UTF-8 bytes are rejected before the parser can truncate them. Ordinary UTF-8 quoted identifiers work; `U&"..."` identifiers are rejected until decoding and length checks are implemented.
- Embedded NUL bytes and unpaired Unicode surrogates are rejected before parser access because they can truncate or change input.

Source locations use a line-start index, and DEFAULT extraction uses scanner token boundaries and a DEFAULT-token index. Punctuation inside strings and comments does not terminate an expression. There is no worker infrastructure yet. Input-size/depth limits reduce exposure but do not establish a hard memory or wall-clock bound; revisit process isolation before offering this adapter as an untrusted-input service.

## Checks and remaining work

```sh
npm run test:postgres
npm run check
```

A successful result is **structural normalization, not proof that SQL would execute on a PostgreSQL server**. Default values/casts, enum-member defaults, function availability, runtime data, server limits, collation, and catalog operator compatibility are not fully validated here. No generated TypeORM project, metadata, database catalog, NestJS consumer, or Aurora environment has been checked by this adapter suite. Database execution belongs in disposable integration tests, never ordinary generation.

The separate internal [naming layer](naming.md) resolves entity classes, scalar properties, and basenames with declarative naming overrides and collision diagnostics. It does not change these physical schema facts. The [direct DBML adapter](dbml-normalization.md) maps its supported subset into the same contract without SQL export. Entity emission, the public library API, CLI, safe regeneration, and release packaging follow the [implementation plan](implementation-plan.md).

PostgreSQL reference pages for engine integration review: [character limits](https://www.postgresql.org/docs/18/datatype-character.html), [numeric limits](https://www.postgresql.org/docs/18/datatype-numeric.html), and [JSON comparison operators](https://www.postgresql.org/docs/18/functions-json.html). These references do not replace engine integration tests.
