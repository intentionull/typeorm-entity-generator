# Research and parser evaluation

Reviewed on **2026-10-09**. Versions below are the npm registry values observed during this review, not permanent compatibility promises. Recommendations are marked as such; documented capabilities and local observations are cited separately.

## Recommendation

Build a local, deterministic schema compiler, not a string-replacement utility. Parse each input into a project-owned relational schema model, validate it, resolve names and relationships, and emit TypeScript through a structured syntax API.

Start with **PostgreSQL SQL DDL and DBML targeting PostgreSQL**. Add other dialects only after their fixtures prove that types, defaults, keys, and indexes survive. The first useful expansion is read-only database inspection, followed by a versioned JSON/YAML interchange format.

Do not use DBML as the universal intermediate format. The local SQL-to-DBML evaluation accepted all eight PostgreSQL fixtures but lost details in three of them. See the evaluation below.

## Useful input alternatives

These priorities are product recommendations, not claims of implemented support.

| Priority | Input | Value | Recommended integration |
| --- | --- | --- | --- |
| First release | PostgreSQL SQL DDL | Common schema source; preserves database-specific definitions | Parse with the PostgreSQL grammar; interpret a tested DDL subset in statement order |
| First release | DBML | Compact, reviewable database design with keys, enums, and relationships [1][2] | Use `@dbml/core` in `dbmlv2` mode, then map its database object directly |
| Next | Live PostgreSQL database | Actual catalog metadata removes ambiguity about applied migrations | Read-only adapter using public TypeORM inspection methods and targeted catalog queries [10] |
| Next | Schema-only SQL dump | Fits existing backup, design, and migration workflows [12] | A dialect-specific SQL import profile with explicit handling of dump directives |
| Next | Relational JSON document | Stable API for other tools; easy fixtures and schema caching | Version the project's schema contract and validate every field |
| Next | YAML version of that document | Easier hand editing without inventing another schema language | Same contract as JSON; restrict aliases and disallow custom executable tags |
| Later | SQLite database file and SQLite DDL | Useful for local applications and prototypes | Read-only file inspection first; test type affinity, rowid, generated columns, and foreign keys |
| Later | MySQL/MariaDB SQL and live metadata | Expands the main relational use cases | Dedicated type/default mappings; test unsigned values, enum/set, collation, indexes, and generated columns |
| Later | Prisma schema | Useful for moving an existing schema into TypeORM | Accept baseline SQL exported by `prisma migrate diff` first [13] |
| Later | Drizzle schema | Useful for teams with TypeScript schema definitions | Accept SQL from `drizzle-kit export` first [14]; do not execute a supplied TypeScript file |
| Later | Liquibase XML/YAML/JSON changelog | Useful for enterprise migration repositories | Prefer externally exported SQL or catalog inspection; a direct adapter must model ordering, includes, conditions, and substitutions [15] |
| Later | Rails `schema.rb` | Established declarative schema source | Evaluate the documented `schemarb` parser path [1]; never execute Ruby |
| Low | Mermaid ER diagram | Documentation-first modeling | Require mappings for missing physical details; Mermaid attribute types are not a fixed database type system [16] |
| Low | Atlas HCL or inspection export | Another schema-management integration | Accept SQL or a mapped inspection document rather than adding a required external executable [17] |

Treat ordered migration directories as a separate input mode, not a synonym for a final schema. SQL migration files can alter earlier definitions; application-language migrations can execute arbitrary code. Support only an explicitly documented declarative subset, or ask users to export the final schema outside this package.

OpenAPI, JSON Schema, GraphQL SDL, TypeScript interfaces, CSV files, and sample JSON objects do not by themselves specify a physical relational schema. An adapter would need explicit column types, table identity, primary/foreign keys, nullability, and constraint mappings. Do not infer these from names or sample data. These are low-priority integration ideas, not first-release inputs.

## Parser choices

| Candidate | Observed version / license | Evidence | Recommendation |
| --- | --- | --- | --- |
| `@dbml/core` | `10.3.1` / Apache-2.0 | Official API returns a `Database` object; `dbmlv2` is preferred and the older `dbml` mode is deprecated [1][3] | Use for DBML. Keep an explicit translation layer; do not expose its internal objects as the public contract |
| `libpg-query` | `18.1.5` / MIT | PostgreSQL C parser compiled to WebAssembly; no native build required according to the project [4][5]. Accepted all eight local SQL fixtures | Preferred PostgreSQL SQL parser. Load asynchronously and retain source locations and raw expressions |
| `pgsql-parser` | `18.2.10` / MIT | Adds a SQL deparser on the PostgreSQL parser stack [6] | Consider if normalized expression rendering is needed; not required just to emit entity files |
| `node-sql-parser` | `5.4.0` / Apache-2.0 | Multiple dialects and AST/location options [7][8]. Rejected two PostgreSQL generation fixtures | Candidate for later non-PostgreSQL adapters, not a universal fidelity guarantee |
| `pgsql-ast-parser` | `12.0.2` / MIT | Typed, readable AST; project documents incomplete syntax coverage and no PL/pgSQL support [9] | Easier mapping but weaker coverage assurance. Prefer the PostgreSQL grammar for the initial SQL adapter |

Parsing does not resolve a catalog. Even the PostgreSQL parser does not decide whether a referenced table exists, fold every identifier into a canonical path, apply prior `ALTER TABLE` statements, or prove TypeORM can represent a feature. That work belongs in normalization and validation.

The DBML parser also accepts other SQL dialects [1]. That is useful functionality, but it is not evidence that every dialect-specific detail survives in the DBML representation.

### Do not write a SQL parser with regular expressions

Quoted identifiers, semicolons inside strings, expressions, dollar-quoted functions, and dialect-specific syntax need a grammar-aware reader. A parser AST plus a small schema-state interpreter is a safer boundary. Unsupported schema-changing statements should stop generation, with their location and reason.

### Do not execute input SQL to discover the schema

Applying a dump to a database can execute functions, extensions, file operations, and other unwanted effects. The normal npm CLI must remain a parse-only tool. Disposable database execution belongs only in controlled integration tests using project fixtures, never as an automatic fallback for a user's input.

## Local parser evaluation

Experiments ran outside the repository in `/tmp/typeorm-entity-research.D22bKj`, using Node `22.22.2`. Dependencies were installed at the versions in the table with lifecycle scripts disabled. No application or production database was contacted.

Eight independent PostgreSQL SQL fixtures were passed to:

- `await parse(sql)` from `libpg-query@18.1.5`;
- `new Parser().astify(sql, { database: "Postgresql" })` from `node-sql-parser@5.4.0`;
- `new Parser().parse(sql, "postgres")` and `ModelExporter.export(database, "dbml")` from `@dbml/core@10.3.1`.

| Fixture | PostgreSQL parser | General SQL parser | SQL-to-DBML result |
| --- | --- | --- | --- |
| Bigint primary key, numeric precision/scale, defaults | Accepted | Accepted | Visible details retained in export |
| `GENERATED ALWAYS AS IDENTITY` | Accepted; `generated_when: "a"` retained | Rejected | Accepted; exported as `[increment]`, without the `ALWAYS` identity distinction |
| Stored computed column | Accepted | Rejected | Accepted; expression and `STORED` absent from export |
| Composite foreign key added through `ALTER TABLE`, `ON DELETE CASCADE` | Accepted | Accepted | Composite reference and delete action visible in export |
| Partial index with `WHERE amount > 0` | Accepted; `IndexStmt.whereClause` retained | Accepted | Accepted; predicate absent from export |
| Named enum and `text[]` column | Accepted | Accepted | Enum values and array type visible in export |
| Named check constraint | Accepted | Accepted | Name and expression visible in export |
| Quoted schema/table/column names | Accepted | Accepted | Visible names retained in export |

Acceptance counts: **8/8**, **6/8**, and **8/8**, respectively. These are syntax and limited preservation observations, not end-to-end generator coverage. Details described as retained were visible in the inspected export; no live database equivalence test was performed.

Both general-parser failures reported:

```text
Expected "--", "/*", "BY", or [ \t\n\r] but "A" found.
```

The stored-column fixture was:

```sql
CREATE TABLE orders (
  id int PRIMARY KEY,
  amount numeric(12,2),
  doubled numeric(12,2) GENERATED ALWAYS AS (amount * 2) STORED
);
```

Its DBML export contained an ordinary `doubled numeric(12,2)` column with no generation expression. A converter that uses this export as its sole schema representation cannot reconstruct the lost expression.

The partial-index fixture was:

```sql
CREATE TABLE orders (id int PRIMARY KEY, amount numeric(12,2));
CREATE INDEX orders_positive ON orders(amount) WHERE amount > 0;
```

Its DBML export contained:

```dbml
Indexes {
  amount [name: "orders_positive"]
}
```

The identity fixture was:

```sql
CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
```

Its DBML export contained:

```dbml
Table "orders" {
  "id" bigint [pk, increment]
}
```

A separate DBML fixture with two tables, a composite primary key, and a composite foreign key with a delete action parsed successfully in `dbmlv2` mode. Assertions checked that the result had two tables and two field names at the reference endpoint.

**Conclusion:** the evaluated DBML SQL path is unsuitable as the only PostgreSQL intermediate representation when faithful generation is the goal. This conclusion is limited to the observed versions and fixtures; it is not a claim that all DBML SQL imports are lossy.

## TypeScript emission

**Recommendation:** begin with `ts-morph@28.0.0` and in-memory source files. It provides structured imports, classes, properties, and decorators [18]. Keep formatting deterministic and do not load a consuming application's TypeScript configuration implicitly.

The local smoke check used `ts-morph` to create an entity class containing:

- explicit PostgreSQL table/schema names;
- a bigint identity primary column with `generatedIdentity: "ALWAYS"`;
- a numeric column with precision and scale;
- a partial index with its predicate.

The generated file compiled with **TypeScript `7.0.2` against TypeORM `1.1.2`**, with strict checking, NodeNext module resolution, legacy decorators, decorator metadata, and `skipLibCheck` enabled. This proves that specific emitted sample type-checks; it does not prove runtime database behavior or all emitted patterns.

A current-version trap surfaced during the check: `require("typescript")` at `7.0.2` exposed version information, but not the legacy `createPrinter` or `factory` API. The observed package exposes newer APIs under `unstable/*` paths [19]. `ts-morph@28.0.0` supplied compiler API version `6.0.2`, whose printer was available. Keep emission tied to a tested syntax library instead of assuming the latest TypeScript package has the older compiler API.

This was an explicit tooling adjustment: use the tested `ts-morph` API for emission and the current TypeScript CLI for compilation. Do not silently swap compiler APIs or claim that their version numbers match.

## TypeORM requirements

The current npm `latest` version observed was **`1.1.2`**, licensed MIT, with Node engines `^20.19.0 || ^22.13.0 || >=24.11.0` [20]. The TypeORM 1.0 release notes document breaking platform and driver changes, including MySQL's move to `mysql2` and SQLite's move to `better-sqlite3` [21].

**Updated runtime recommendation:** target TypeORM 1.x first, use Node 24 LTS for development (minimum `24.11.0`), and test generated projects on Node 24 and 26. The earlier experiments on Node 22 remain historical evidence, not the current project support policy. Treat 0.3 compatibility as a separate, explicitly tested output profile. Do not publish an unverified peer range claiming both generations work.

TypeORM supports decorated classes and `EntitySchema` definitions [22][23]. Its docs show composite join columns and distinguish database delete actions from persistence cascades [24]. Important output rules follow:

- Preserve physical column/table/schema names, precision, scale, lengths, enum names, arrays, defaults, and foreign key actions.
- Map bigint to `string` by default; the TypeORM docs explicitly warn that SQL bigint does not fit the ordinary `number` type [22].
- Keep decimal/numeric precision safe by default and make alternate driver conversions explicit. Timestamp, date, JSON, and binary mappings need driver-aware fixtures.
- Infer one-to-one only from an exact qualifying unique key over the complete referencing column set. A name ending in `_id` is not a foreign key.
- Preserve all join-column pairs in a composite foreign key. Map TypeORM referenced column names to entity property names while retaining physical join-column names [24].
- Do not turn an arbitrary table with two foreign keys into an implicit join table. Keep an explicit entity unless an opt-in, tested rule proves it is a pure junction table.
- Do not infer `CreateDateColumn`, `UpdateDateColumn`, or soft-delete behavior from column names. Those decorators add application behavior [22].
- Leave persistence cascades, eager loading, and lazy loading disabled unless configured explicitly. Database `ON DELETE CASCADE` is a different setting [24].
- Use a deliberate strategy for circular entity references. String relation targets plus type-only imports are documented [25]; runtime import cycles need independent ESM and CommonJS tests.
- Do not pretend every database index can be emitted faithfully. TypeORM documents unsupported index definitions and a `synchronize: false` mechanism for externally managed indexes [26].

Triggers, stored procedures, row-level security policies, grants, extension setup, partitioning, and other database-managed behavior are not ordinary entity properties. Keep them in diagnostics or externally managed schema details. Strict mode must distinguish a documented exclusion from a schema detail that was accidentally dropped.

## Existing systems

`typeorm-model-generator` is an MIT-licensed database-to-entity tool supporting multiple database engines. Its README states that the project is in a maintenance phase [27][28]. It is a useful fixture and behavior reference, not the recommended foundation for a new file-first, current-TypeORM package.

Atlas demonstrates a similar schema-inspection-to-TypeORM pipeline, including SQL input and multi-file template output [17]. Borrow the architecture lesson: separate normalized schema information from output rendering. Do not assume the example template is a complete type/relation mapper or make Atlas a required npm runtime dependency.

## MIT and public npm distribution

The repository already contains an MIT license with copyright `2026 intentionull`. Keep it as the project's license. `@dbml/core` and `node-sql-parser` have Apache-2.0 metadata; PostgreSQL parser packages and `ts-morph` have MIT metadata [3][5][6][8][18].

Dependency licenses do not become MIT merely because the package is MIT. Preserve required upstream license and notice files when redistributing dependency code. Apache-2.0 section 4 sets redistribution obligations [29]. Prefer external runtime dependencies over bundling them into the CLI; still audit actual installed transitive licenses and the packed archive before release. This review did not complete a transitive license audit because no runtime dependency set has been committed.

### Package name

The unscoped registry endpoint returned a record for `typeorm-entity-generator` with all three 2022 versions unpublished [30]. That does not confirm availability or current ownership. npm also disallows reusing an already published name/version pair [31].

The candidate scoped endpoint `@intentionull/typeorm-entity-generator/latest` returned **404** [32]. Recommend that name if the owner controls the npm scope. The response proves only that a current release was not returned; it does not establish account ownership or reserve the name.

### Publishing method

Use a public GitHub repository, a public scoped npm package, and trusted publishing with provenance after package ownership and initial setup are settled [33][34]. The npm docs reviewed require npm CLI **11.5.1+**, Node **22.14.0+**, and supported hosted CI runners for trusted publishing. Self-hosted runners were not supported in that documentation [33]. The local npm CLI was `10.9.7`, so it is not the recommended trusted-publishing environment.

The first publish and trusted-publisher setup remain release tasks, not work performed in this review. Do not run publishing automatically from ordinary test workflows or configure a release workflow to accept untrusted input.

## Limits of this review

- No generator implementation, library API, CLI, or npm artifact exists yet.
- No MySQL, MariaDB, SQLite, SQL Server, or Oracle fixture evaluation was performed.
- No live database inspection, TypeORM metadata round trip, or database synchronization comparison was run.
- No npm namespace ownership or publishing permission was verified.
- Tagged and branch-based TypeORM source URLs for `QueryRunner.ts` both returned 404; inspection API claims were checked against the published `1.1.2` declaration instead [10].
- The experimental harness stays in a temporary directory. The fixtures, observed losses, versions, and invocation details above are the durable record.

## Sources

All sources below were accessed on **2026-10-09**. Registry entries and moving documentation can change; recheck them when selecting release dependencies.

1. [DBML core API and parser modes](https://dbml.dbdiagram.io/js-module/core/)
2. [DBML syntax: schemas, indexes, checks, enums, and relationships](https://dbml.dbdiagram.io/docs/)
3. [DBML core registry metadata](https://registry.npmjs.org/@dbml%2fcore/latest)
4. [PostgreSQL WebAssembly parser documentation](https://github.com/constructive-io/libpg-query-node/blob/main/README.md)
5. [libpg-query registry metadata](https://registry.npmjs.org/libpg-query/latest)
6. [pgsql-parser documentation](https://github.com/constructive-io/pgsql-parser/blob/master/README.md) and [registry metadata](https://registry.npmjs.org/pgsql-parser/latest)
7. [node-sql-parser documentation](https://github.com/taozhi8833998/node-sql-parser/blob/master/README.md)
8. [node-sql-parser registry metadata](https://registry.npmjs.org/node-sql-parser/latest)
9. [pgsql-ast-parser documented coverage](https://github.com/oguimbal/pgsql-ast-parser/blob/master/readme.md) and [registry metadata](https://registry.npmjs.org/pgsql-ast-parser/latest)
10. [TypeORM 1.1.2 published QueryRunner declaration](https://unpkg.com/typeorm@1.1.2/query-runner/QueryRunner.d.ts)
11. [TypeORM 1.1.2 package metadata](https://unpkg.com/typeorm@1.1.2/package.json)
12. [PostgreSQL pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
13. [Prisma baseline SQL export](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining)
14. [Drizzle Kit SQL export](https://orm.drizzle.team/docs/drizzle-kit-export)
15. [Liquibase changelog format and processing](https://docs.liquibase.com/concepts/changelogs/home.html)
16. [Mermaid ER diagram syntax](https://mermaid.js.org/syntax/entityRelationshipDiagram.html)
17. [Atlas TypeORM entity generation guide](https://atlasgo.io/guides/orms/typeorm/generate-entities)
18. [ts-morph setup and compiler configuration](https://ts-morph.com/setup/) and [registry metadata](https://registry.npmjs.org/ts-morph/latest)
19. [TypeScript 7.0.2 registry metadata](https://registry.npmjs.org/typescript/7.0.2)
20. [TypeORM current registry release](https://registry.npmjs.org/typeorm/latest)
21. [TypeORM 1.0 release notes](https://typeorm.io/docs/releases/1.0/release-notes)
22. [TypeORM entities, types, and generated columns](https://typeorm.io/docs/entity/entities/)
23. [TypeORM EntitySchema definitions](https://typeorm.io/docs/entity/separating-entity-definition/)
24. [TypeORM relation options and composite join columns](https://typeorm.io/docs/relations/relations/)
25. [TypeORM relation FAQ and circular imports](https://typeorm.io/docs/relations/relations-faq/)
26. [TypeORM index support and synchronization exclusions](https://typeorm.io/docs/indexes/)
27. [typeorm-model-generator scope and maintenance notice](https://github.com/Kononnable/typeorm-model-generator/blob/master/README.md)
28. [typeorm-model-generator registry metadata](https://registry.npmjs.org/typeorm-model-generator/latest)
29. [Apache License 2.0, including redistribution conditions](https://www.apache.org/licenses/LICENSE-2.0)
30. [Unscoped package registry record](https://registry.npmjs.org/typeorm-entity-generator)
31. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish)
32. [Candidate scoped package endpoint](https://registry.npmjs.org/@intentionull%2ftypeorm-entity-generator/latest)
33. [npm trusted publishing requirements and provenance](https://docs.npmjs.com/trusted-publishers/)
34. [npm package metadata, licenses, files, exports, and executable entries](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
