# TypeORM Entity Generator

Generate TypeORM entity files from database schemas, preserving names, column types, keys, and relationships.

**Status:** development tooling, parser fixtures, internal PostgreSQL SQL and direct DBML normalization, pure naming, and a bounded PostgreSQL entity emitter are implemented. The emitter returns files in memory; it does not write them. The public library API, CLI, and safe writer are not implemented. The package remains private and unpublished. Generation commands below describe the proposed interface, not commands that work today.

## Fixture checks

A private development harness now checks nine pinned upstream DBML examples, four local invalid inputs, and three independently written PostgreSQL SQL/DBML pairs. It verifies source hashes, expected parser diagnostics, and selected schema facts; it does not verify generated entities or database compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:fixtures
```

Use Node.js **24.11.0 or newer**. Node 24 LTS is the development default; `.nvmrc` selects its latest available patch for `nvm install` and `nvm use`. Node 26 is the current-release verification target. Node 22 is no longer a supported project target. See the [fixture corpus guide](tests/fixtures/README.md) for provenance, licensing, coverage, and limitations.

The [CI workflow](.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatch, using the latest available patches of Node 24 and 26 on Ubuntu. Each lane installs locked dependencies with engine requirements enforced and dependency lifecycle scripts disabled, then runs `npm run check` and separate disposable PostgreSQL catalog checks. Tests compile and execute strict ESM consumers against TypeORM 1.1.2, inspect independent metadata expectations, and compare selected physical catalog facts against PostgreSQL 18.4. See the [emission profile](docs/postgres-emission.md) for the exact evidence and exclusions. These checks do not establish NestJS, persistence, Aurora, or Data API compatibility.

## Repository checks

Run `npm run check` for the database-free contributor gate, and `npm run test:catalog` against disposable local PostgreSQL for the integration gate. See the [toolchain guide](docs/toolchain.md) for commands and license boundaries, the [PostgreSQL support table](docs/postgres-normalization.md), [DBML support table](docs/dbml-normalization.md), [naming guide](docs/naming.md), and [emission profile](docs/postgres-emission.md) for supported behavior and exclusions.

`npm run check:docs` needs no installed dependencies and never edits files. It checks local Markdown links, code-fence balance, and restricted terminology in repository text and filenames. Required legal notices are exempt; pinned upstream source stays unchanged. See the [check guide](docs/documentation-check.md) for syntax coverage, exclusions, and limitations. This static check does not prove documentation accuracy or execute examples.

## Planned inputs

The first release should accept:

- **SQL DDL**, beginning with PostgreSQL and an explicit dialect.
- **DBML**, parsed directly rather than converted through SQL.

Useful additions, in priority order:

| Input | Why it belongs | Boundary |
| --- | --- | --- |
| Live database metadata | Generates entities from the actual deployed schema | Read-only access; explicit tables and schemas; optional drivers |
| Schema-only SQL dumps | Works with existing export and migration tools | A SQL import profile, not a separate parser; report unsupported dump directives |
| Versioned JSON schema document | Gives other tools a stable integration format | Define a relational schema contract; do not accept arbitrary JSON as a database schema |
| YAML schema document | Makes the same contract easier to edit by hand | Same validation as JSON; no executable tags |
| SQLite database file | Convenient for local applications and prototypes | Open read-only; preserve SQLite-specific type semantics |
| Prisma and Drizzle schemas | Helps teams move between schema tools | Start with their SQL exports; direct adapters need separate compatibility tests |
| Liquibase changelogs | Fits migration-heavy projects | Includes, conditions, and change order make this a later integration |
| Rails `schema.rb` | Supports another established schema source | Parse a documented subset; never execute Ruby |
| Mermaid ER diagrams | Useful for documentation-first projects | Incomplete physical schema information; require explicit mappings |

API descriptions and object validation schemas are not reliable relational inputs by themselves. They need explicit database types, primary keys, foreign keys, and constraint mappings.

## Design

```text
input adapter
  -> versioned schema model
  -> validation and dialect checks
  -> name and relationship resolution
  -> TypeORM emitter
  -> reviewable file plan
  -> safe writer
```

Keep SQL and DBML adapters separate. Parser acceptance alone does not prove that schema details survived. The local evaluation found lost PostgreSQL identity and index details when SQL was converted through DBML.

Default output should be decorated TypeScript classes. `EntitySchema` output is a useful second format for projects that do not use decorators. Unknown types and unrepresentable constraints must produce explicit diagnostics, never guessed replacements.

The approved implementation order is PostgreSQL SQL/DBML with a tested NestJS integration, then MySQL and native Aurora coverage, followed by additional dialects and dedicated RDS Data API support. Aurora PostgreSQL and Aurora MySQL use their respective engine dialects; native connections and the Data API are separate runtime profiles. None of these deployment profiles is implemented or verified by this repository yet.

Keep entities framework-neutral. A planned NestJS preset adds an explicit registry and optional persistence module, not application services or a second schema-conversion path.

## Proposed interface

```sh
typeorm-entity-generator generate schema.sql --format sql --dialect postgres --out src/entities
typeorm-entity-generator generate schema.dbml --format dbml --dialect postgres --out src/entities
typeorm-entity-generator generate schema.sql --format sql --dialect postgres --out src/entities --dry-run
typeorm-entity-generator generate schema.sql --format sql --dialect postgres --out src/entities --check
```

File generation must not execute input SQL, change a database, or overwrite unrelated files. Existing hand-edited output should stop the write with a useful conflict report.

## Project documents

- [Research and parser evaluation](docs/research.md): current sources, input priorities, dependency choices, and observed limitations.
- [Architecture and release plan](docs/architecture.md): schema fidelity, output safety, testing, and public npm packaging.
- [Internal implementation plan](docs/implementation-plan.md): approved order, milestone owners, acceptance checks, contributor extension guidance, and release blockers.
- [Contribution rules](CONTRIBUTING.md): vocabulary, development, and contribution requirements.

## Package and license

The intended distribution is a **public npm package under the MIT license**. `@intentionull/typeorm-entity-generator` is the recommended candidate name, subject to npm account and scope ownership checks. The unscoped name has an unpublished-package record; its availability is not confirmed.

[MIT](LICENSE), copyright 2026 intentionull. Third-party dependencies retain their own licenses.

## Contributing and security

See [Contributing](CONTRIBUTING.md) for the contributor gate, review requirements,
and dependency maintenance. Report suspected vulnerabilities privately using the
[security policy](SECURITY.md), not a public issue.
