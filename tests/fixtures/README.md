# Schema fixture corpus

This directory contains checked DBML inputs and three independently written PostgreSQL SQL/DBML pairs. It is development-only material, not a set of implemented generator features or published package examples.

## Run the checks

From the repository root, with Node.js 24.11.0 or newer (Node 24 LTS is the development default):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:fixtures
```

`npm test` runs the same suite. Dependency installation uses the registry; the tests themselves require no network, credentials, database, or cloud account. They parse input only: no SQL, application code, or schema migration is executed.

With nvm, run `nvm install` and `nvm use` in the repository root before installing dependencies. The `.nvmrc` file selects the latest available Node 24 patch. Node 24 and Node 26 are the verification lanes; an open-ended package engine range does not prove compatibility with untested future majors.

### Verified runtime versions

Each row passed a clean `npm ci --engine-strict --ignore-scripts --no-audit --no-fund` followed by `npm test`, using official Node.js Linux x64 archives verified against their published SHA-256 checksums.

| Node.js | Bundled npm | Fixture tests |
| --- | --- | --- |
| 24.11.0 (minimum) | 11.6.1 | 18 passed, 0 failed |
| 24.21.0 (Node 24 LTS patch checked) | 11.19.0 | 18 passed, 0 failed |
| 26.11.1 (current-release patch checked) | 11.20.0 | 18 passed, 0 failed |

These are parser-fixture results, not generator, TypeORM, NestJS, database, or cross-platform compatibility results. The [official release list](https://nodejs.org/en/about/previous-releases) identifies current releases; the versions above record the specific runtimes checked rather than updating automatically with that list.

The private development manifest and lockfile pin `@dbml/core@10.3.1` and `libpg-query@18.1.5`. The DBML checks use `dbmlv2`. Changing the parsers requires reviewing diagnostic changes and schema facts, not automatically refreshing expectations.

The [CI workflow](../../.github/workflows/ci.yml) runs this suite on Node 24 and 26 using clean, engine-strict installs with dependency lifecycle scripts disabled. Strict TypeScript tooling and separate compiled PostgreSQL SQL/DBML normalization and naming tests are implemented. The repository does not yet implement entity emission, a CLI, or a public library API. These corpus checks establish integrity and selected parser semantics only, not adapter acceptance, generated-project, or database compatibility. See the [DBML support table](../../docs/dbml-normalization.md) for normalization boundaries.

## Normalization applications and regressions

Five [locally authored MIT application examples](applications/) cover commerce, tenancy, permissions, content, and scheduling. They are representative schemas, not copied application dumps or adaptations of the upstream corpus. [Complete handwritten physical facts](../dbml-application-expectations.ts) and [application tests](../dbml-applications.test.ts) provide the semantic oracle; helpers construct expected contract objects and parse no source. No snapshot is copied from adapter output.

[Reduced regression inputs](regressions/README.md) retain parser failures with their expected rejections and origins. The [coverage matrix](../../docs/dbml-coverage.md) distinguishes parser/provenance tests, cross-adapter equality, complete application oracles, deterministic generated cases, exact boundaries, and pending emission/catalog proof. `npm run test:dbml` runs every DBML semantic suite; `npm run check` includes the parser/provenance suite too. Leave all pinned upstream bytes and attribution unchanged when adding local cases.

## Upstream DBML

Nine original files are pinned in [upstream/manifest.json](upstream/manifest.json). Seven must parse; two must fail with the listed diagnostics. The manifest contains repository URLs, exact commits, source paths, local paths, SHA-256 hashes, license records, intended target profiles, and manually specified expectations.

| Sample | Source | Expected parsing | Purpose |
| --- | --- | --- | --- |
| `commerce` | Official DBML examples | Accept | Five-table commerce model, enum references, indexes, relationships |
| `simple` | Official DBML examples | Accept | Primary key, uniqueness, nullability, expression default |
| `general` | Official DBML test inputs | Accept | Composite index, hash index, quoted enum names, relationships |
| `schemas` | Official DBML test inputs | Accept | Schema qualification, table aliases, enum qualification |
| `enums` | Official DBML test inputs | Accept | Quoted identifiers and schema-qualified enums |
| `many-to-many` | Official DBML test inputs | Accept | Inline and composite many-to-many declarations |
| `null-defaults` | Official DBML test inputs | Accept | Null, string, and numeric default syntax |
| `php-parser-invalid` | MIT-licensed parser sample | Reject | Chained reference, missing column/table references |
| `go-parser-invalid` | MIT-licensed parser sample | Reject | Invalid identifier syntax, chained reference, missing tables |

These are language examples and parser fixtures, not verified production application schemas. The two invalid samples declare MySQL; rejecting their syntax is not a claim of MySQL generation support. Some accepted samples contain types, relationship shapes, or uniqueness problems that a target adapter must diagnose. Parser acceptance alone does not prove valid PostgreSQL semantics or faithful TypeORM output.

Every upstream file is unmodified. Legal files are copied verbatim under each source's `legal/` directory. The DBML repository is Apache-2.0; both other source repositories are MIT. Their notices remain in force: the project license does not relicense these inputs. No applicable upstream `NOTICE` file was found in the selected files' ancestor directories at the pinned revisions.

## Independent SQL/DBML pairs

The pair files are authored here under the repository's MIT license; neither format was exported from the other. Each DBML project explicitly selects PostgreSQL.

| Pair | Selected facts checked independently in both formats |
| --- | --- |
| [basic](pairs/basic.dbml) / [SQL](pairs/basic.sql) | Columns, primary key, unique/non-null email, length, numeric precision/scale, zero/boolean/expression defaults, nullable text |
| [tenant](pairs/tenant.dbml) / [SQL](pairs/tenant.sql) | Schema-qualified enum and escaped label, composite primary/unique keys, ordered composite foreign-key columns, delete/update actions, string default |
| [quoted](pairs/quoted.dbml) / [SQL](pairs/quoted.sql) | Physical schema/table/column names with spaces, nullable self-reference, character length, named btree index |

The assertions live in [fixtures.test.mjs](../fixtures.test.mjs). Expected facts are literal, independently reviewed assertions, not exporter snapshots. The test helpers read parser structures; they are not production input adapters or a substitute for the versioned schema contract.

These pairs cover selected shared facts, not a proof of full semantic equivalence. In particular, DBML does not specify every SQL constraint name or constraint option. The [compiled DBML tests](../dbml.test.ts) compare the normalized pair outputs, while the application tests above compare complete physical schemas against handwritten expectations. Database catalog and TypeORM compilation/metadata checks remain later milestones.

Two parser representations receive explicit handling in the adapters: DBML boolean defaults retain a boolean type tag but store the value as text (`'true'`); the PostgreSQL parser retains an integer constant node for zero but omits its numeric value. The parser and normalization assertions check these representations without confusing boolean defaults with string defaults or zero with a missing default.

## Invalid local inputs

Four small DBML fixtures isolate missing columns, duplicate tables, unequal reference arity, and an unterminated table. [invalid/expectations.json](invalid/expectations.json) specifies the intended parser diagnostic for each case. A generic thrown exception is not enough to pass.

The compiled normalization suites separately cover unknown target types, non-unique reference targets, ambiguous relationships, unsupported schema features, and naming collisions. Those are not all DBML syntax errors; see the [coverage matrix](../../docs/dbml-coverage.md) for the diagnostic boundaries.

## Adding or updating a fixture

1. Identify a specific schema fact or failure to exercise and add an independent assertion before changing behavior.
2. For upstream input, verify the exact file's license and any applicable ancestor notices. Record a full commit and original source path; preserve source bytes and legal text.
3. Write expectations by inspecting the schema, not by saving a converter's output. Preserve invalid upstream inputs as negative cases instead of silently repairing them.
4. Update the manifest hashes only after reviewing changed bytes. Do not fetch upstream files during normal tests.
5. Run the fixture suite and document whether the result proves parsing, adapter fidelity, compilation, or database behavior. Do not interchange those claims.

Keep this corpus, its legal files, and research documents outside any future public npm tarball allowlist. The previously collected application SQL corpus remains separate temporary research material; it was not imported by this change.
