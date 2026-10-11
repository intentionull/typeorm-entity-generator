# Architecture and release plan

This is the target design. Development tooling, a bounded internal [PostgreSQL normalizer](postgres-normalization.md), and pure [entity/column naming](naming.md) with declarative overrides are implemented; the public API, generation pipeline, CLI, and integrations remain planned. The approved order and current milestone status are recorded in [implementation-plan.md](implementation-plan.md). Research evidence and dated version observations are recorded in [research.md](research.md).

## Product boundary

A local CLI and typed library convert a declared relational schema into TypeORM files. They must preserve schema semantics or explain what cannot be represented. File generation must not execute SQL, connect to a database, or load executable application configuration.

A later database-inspection command is a separate, explicit operation. Require read-only credentials, an explicit schema/table scope, and a connection timeout. Do not collect row data, synchronize schemas, run migrations, or log connection strings.

## Pipeline

```text
SQL / DBML / later adapters
          |
          v
versioned relational schema model
          |
          v
schema and dialect validation
          |
          v
name, type, and relationship resolution
          |
          v
TypeORM classes / later EntitySchema output
          |
          v
file plan + diagnostics
          |
          v
conflict checks + staged writer
```

Separate pure conversion from filesystem and connection access. A library caller should be able to inspect the complete result without writing files.

## Database and integration profiles

Keep input format, source dialect, target database/version capabilities, runtime profile, and output integration separate. SQL dialect and target engine must agree in the initial release; cross-database translation is not ordinary generation. DBML requires an explicit target engine.

Aurora PostgreSQL and Aurora MySQL use their respective engine dialects. Native connections use TypeORM's `postgres` or `mysql` profiles. The `aurora-postgres` and `aurora-mysql` profiles use the RDS Data API and require separate transport/value tests. Do not select the Data API simply because a deployment uses Aurora or serverless capacity.

Use small internal capability tables and type-mapping functions. Reject unsupported features or report an explicitly permitted external-management exclusion; do not silently downgrade types, constraints, or expressions. Local PostgreSQL/MySQL tests do not prove Aurora-specific compatibility. Track native and Data API evidence separately, including tested engine and runtime versions.

Connection endpoints, TLS, credentials, IAM, pooling, and reader/writer routing belong to the consuming application. File-only generation must not need database drivers, AWS SDKs, TypeORM, or NestJS at runtime.

Keep entities framework-neutral. The planned NestJS preset adds a shared explicit entity registry and optional persistence module, with a consistent named-connection policy. Test root registration, repository injection, relation-target registration, and shutdown with the same entities used by plain TypeORM consumers. Do not generate controllers, business services, or authorization rules.

## Schema model

Own the contract rather than re-exporting a parser's AST. Include a contract version and typed structures for:

| Structure | Required information |
| --- | --- |
| Source | Format, declared dialect, source positions, and supported import profile |
| Namespace | Physical schema name and qualification rules |
| Table | Physical table name, ordered columns, primary key, constraints, and indexes |
| Column | Physical name, exact database type, nullability, precision, scale, length, array dimensions, collation, default, and generation strategy |
| Enum | Namespace, physical type name, and ordered values |
| Key | Name, ordered columns, uniqueness, and qualifying predicate where relevant |
| Foreign key | Name, source and target namespaces/tables, ordered column pairs, delete/update actions, and deferrability |
| Index | Name, columns or expressions, uniqueness, method, predicate, included columns, and dialect-specific options |
| Check | Name and preserved SQL expression |
| Default | A tagged distinction between a literal and a database expression |
| Generation | Separate sequence/increment, identity strategy, UUID behavior, and computed expression/storage |
| External detail | A database-managed feature that cannot be emitted as ordinary entity metadata |
| Diagnostic | Stable code, severity, source location, affected object, and explanation |

Keep database names separate from output class, property, and file names. A quoted table called `"Sales"."Order"` must not become a different physical table because its TypeScript class is `Order`.

Preserve expression text or a dialect-aware expression representation. Never turn a database expression into executable JavaScript. Escape all string literals and imports through the emitter.

### Validation rules

- Resolve references and apply supported DDL statements in source order.
- Reject duplicate physical objects, unresolved references, invalid composite key pairs, unknown types, and contradictory constraints.
- Validate that referenced columns form a permitted key for the selected database.
- Keep quoted-identifier case and schema qualification intact.
- Do not silently promote a partial unique index into an unconditional unique constraint.
- Report unrepresentable identity, default, generated-column, constraint, and index details before emitting files.
- Strict mode is the default. Known externally managed features may be accepted only through an explicit, reviewable exclusion policy. Naming collisions and unsafe output paths must always fail.
- Bound input bytes, include depth, object counts, and parser work. Any include feature must reject path escapes and cycles.

## SQL adapter

Use `libpg-query` for PostgreSQL syntax. The initial schema-state interpreter should cover a tested subset of:

- namespace and enum creation;
- table and column definitions;
- primary, unique, check, and foreign key constraints;
- literal/expression defaults and generated columns;
- named indexes, including partial predicates;
- constraint/index additions and supported column changes through ordered `ALTER TABLE` statements.

Do not use the complete parser grammar as the support claim. Define a statement-level capability table and a fixture for every supported transformation. Reject unsupported schema mutations before producing a file plan.

A dump import profile may normalize known inert directives in a syntax-aware preprocessing step. Report each excluded directive. Do not blindly strip all session settings or backslash commands. Reject embedded includes, shell commands, data inserts, and unknown directives by default.

## DBML adapter

Use `@dbml/core` with `dbmlv2`. Map its parsed database object directly into the schema contract. Validate type names, defaults, enum references, indexes, checks, and composite relationships against the selected target dialect.

Treat DBML `Ref` declarations as foreign key intent and preserve their direction and composite column pairs. Validate the qualifying uniqueness needed for a one-to-one relation. A conceptual many-to-many reference without an explicit junction table needs a declared mapping policy; do not silently invent a physical table or extra constraints.

Ignore project/table/column notes by default. Any future note-to-comment export must honor the repository vocabulary rules and report excluded content. Notes are not executable configuration.

## Name and relationship resolution

Use conservative, deterministic name conversion with explicit overrides. Avoid default singularization: English inflection can change valid names unexpectedly. Check reserved words, invalid identifiers, case-insensitive filename conflicts, normalized-name collisions, and collisions between scalar and relation properties.

The internal [naming layer](naming.md) currently resolves classes, scalar properties, and basenames with explicit collision diagnostics while preserving physical schema facts. Relation properties, enum symbols, and emitter import/registry symbol conflicts remain with the emission milestone; they are not checked by the scalar naming layer.

Build relationships from declared foreign keys, not naming conventions:

1. Resolve all referenced tables and ordered column pairs.
2. Emit a many-to-one relation unless a qualifying complete unique key proves one-to-one.
3. Preserve the corresponding scalar foreign key properties and their exact column definitions.
4. Emit inverse relations only under an explicit, deterministic policy.
5. Keep junction tables as entities by default. Payload columns, extra constraints, and composite keys must not disappear behind an implicit many-to-many mapping.
6. Diagnose foreign keys to excluded tables rather than producing dangling imports.

Self-references, multiple foreign keys to the same target, composite keys, and cycles must have independent fixtures. Do not infer persistence cascades from database delete actions.

## TypeORM output

Use `ts-morph` in memory for the initial decorated-class emitter. Explicit database type declarations avoid relying on incidental reflected TypeScript types. Keep import paths, quote style, line endings, and sorting deterministic.

Defaults:

- Emit explicit table, schema, column, key, and constraint names.
- Use `string` for bigint and precision-sensitive decimal/numeric values unless a tested driver configuration selects another mapping.
- Represent nullable columns as `T | null`, not merely optional properties.
- Use definite-assignment properties where constructor initialization is not expected.
- Do not convert a column into a special date/version/soft-delete decorator because of its name.
- Preserve identity strategies and generated expressions when supported by the target TypeORM profile.
- Keep SQL expressions in default callbacks or the appropriate metadata field; do not evaluate them.
- Keep eager/lazy loading and persistence cascades off unless explicitly configured.
- Use a tested circular-reference strategy for the chosen module system. Do not use a type-only import as a runtime relation callback target.
- Mark externally managed indexes appropriately when an explicit exclusion policy permits them.
- Do not generate connection code that turns `synchronize` on.

Add an `EntitySchema` emitter after the shared schema and resolution layers are stable. It should use the same fidelity checks; it is an output format, not a separate conversion engine.

## File safety and repeatability

Resolve every output path under the chosen root. Reject path traversal, absolute names from input, symlink escapes, and case-folding collisions. Inspect all destinations before writing anything.

Generate a manifest containing source/options hashes, owned relative paths, and the last written content hash. Do not include timestamps, absolute machine paths, credentials, or full input dumps.

- New output: refuse to replace an unrelated existing file.
- Repeat generation: update only owned files whose current bytes still match the previous manifest.
- Hand-edited output: report a conflict without writing.
- Removed tables: remove stale owned files only after ownership and content checks.
- `--dry-run`: return the full file plan without filesystem mutation.
- `--check`: return a nonzero result if regeneration would change owned output; do not write.

Stage files before replacing destinations. Per-file rename is not a cross-file transaction: retain rollback information for caught errors and a recoverable journal for interrupted runs. Test interruption, concurrent runs, and disk/write failures before claiming atomic multi-file output.

## Library and CLI

Start as one package, not a monorepo or a separate package per parser. Keep internal adapter and emitter modules small; add a public extension API only after there is a tested second integration that needs one.

The proposed library should expose:

- parse/normalize functions accepting text and explicit format/dialect options;
- a schema-document validation function;
- a pure generation function returning planned files and diagnostics;
- an explicit writer accepting the reviewed file plan;
- a separately loaded database inspection adapter when implemented.

The CLI is a thin layer over these functions. Distinguish invalid input, schema fidelity errors, output conflicts, and internal failures. Support machine-readable diagnostics without exposing credentials or schema data unnecessarily.

Use declarative JSON configuration, optionally YAML later. Do not execute user-supplied TypeScript or JavaScript config files. Make precedence explicit: command-line options, then config, then documented defaults.

## Testing plan

Use behavior-first tests with `node:test` against compiled TypeScript initially. Avoid adding a second transformation stack just to run tests.

| Check | What it proves |
| --- | --- |
| Adapter semantics | Independent source fixtures normalize to expected physical schema facts |
| Negative fixtures | Unsupported syntax, types, references, and unsafe names produce specific errors |
| Relationship tests | Composite joins, uniqueness, junctions, self-references, and cycles remain correct |
| Emitter compilation | Generated fixtures type-check with strict settings against each claimed TypeORM profile |
| Runtime metadata check | TypeORM reads the expected table, column, key, and relation metadata |
| Controlled database comparison | Project fixtures and generated metadata agree on supported schema details |
| NestJS consumer | Ordinary entities register correctly, named repositories resolve, and a controlled database-backed example works |
| Target/transport compatibility | Each advertised profile has its own evidence; local engine tests do not substitute for Aurora or Data API checks |
| Golden output | Stable formatting, imports, naming, and file layout |
| Determinism | Repeated runs with identical inputs/options produce identical bytes and manifest hashes |
| Writer failure tests | Conflicts, traversal, symlinks, concurrent runs, and interruptions cannot silently damage files |
| Packed-package test | The installed tarball exposes working CLI/library entry points and all required assets |
| Vocabulary review | Authored identifiers, source, comments, examples, docs, generated fixtures, and packed contents follow repository rules |

For PostgreSQL integration tests, use a disposable, isolated test database and only project-controlled fixtures. Compare catalog facts with emitted metadata. If testing schema-diff behavior, use TypeORM's inspection/diff facilities without applying writes to an existing database.

At minimum, cover enums, arrays, precision/scale, defaults, identity/sequence generation, computed columns, quoted identifiers, multiple schemas, checks, partial indexes, composite foreign keys, delete/update actions, and nullable relationships. Do not accept output snapshots as the sole proof of fidelity.

## Public npm package

Do not create a publishable placeholder before there is a working CLI and library. At implementation time:

- Use the candidate name `@intentionull/typeorm-entity-generator` only after scope ownership is verified.
- Set `license` to `MIT`, `publishConfig.access` to `public`, and repository/homepage/issues URLs to the project repository.
- Provide a `bin` entry named `typeorm-entity-generator`, a typed root `exports` entry, and explicit exported public types.
- Begin with an ESM library build. Add CommonJS library exports only if tested consumer requirements justify them. Generated-project module support is a separate concern.
- Use Node 24 LTS as the development default with a minimum of `24.11.0`, and Node 24 and 26 in the first CI matrix. Recheck dependency requirements and verify the minimum supported patch when runtime requirements change. Generated-project compatibility needs its own tests; an open-ended engine range does not prove support for future majors.
- Keep file-only generation independent of TypeORM and database drivers at runtime. Generated applications install their own TypeORM dependencies.
- Load database drivers only for the explicit inspection operation. Decide optional peer/dependency declarations when that adapter is implemented.
- Include the WebAssembly/runtime assets required by external parser dependencies. Verify resolution after installing the tarball in a fresh directory.
- Use an explicit package `files` allowlist for compiled output, README, LICENSE, and required notices. Exclude tests, research scratch files, local configuration, dumps, and secrets.
- Commit the lockfile when actual dependencies are selected; run clean installs, tests, type checking, and build checks before packing.
- Inspect `npm pack --dry-run`, create a local tarball, and test the tarball rather than only the source tree.
- Audit direct and transitive licenses. Preserve dependency notices; the project's MIT license does not replace them.
- Verify vocabulary compliance in the tarball as well as the repository.

Use a GitHub-hosted release workflow with npm trusted publishing and provenance once ownership and setup are complete. Keep release permission separate from pull-request checks. Require an explicit release action; do not publish in this design/research task. Recheck npm's runtime requirements when configuring the workflow.

## Implementation order

The detailed milestones, owners, dependencies, and completion checks are in [implementation-plan.md](implementation-plan.md).

1. Bootstrap reproducible development checks and independent failing behavior fixtures.
2. Implement the schema contract, diagnostics, naming, PostgreSQL SQL and DBML adapters, and strict loss detection.
3. Implement the decorated-class emitter, registry, compilation/runtime metadata checks, and disposable PostgreSQL comparisons.
4. Implement the CLI, file plan, manifest, dry-run/check modes, and failure-tested writer.
5. Complete the NestJS example and optional persistence-module preset, including repository injection and database-backed consumer tests.
6. Complete public package readiness, tarball tests, executable documentation, vocabulary review, and license/security review. Publication remains a separate authorized action.
7. Add MySQL SQL/DBML profiles and native Aurora deployment verification without conflating local and cloud evidence.
8. Add further justified dialects and dedicated Data API profiles with adapter/transport-specific tests. Live inspection, JSON/YAML input, and EntitySchema output remain later proposals, not prerequisites for the initial release.

A first release is complete only when its documented subset works end to end. It can reject unsupported features; it must not quietly emit an incomplete interpretation of them.
