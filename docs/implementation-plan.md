# Implementation plan

**Status:** approved implementation order; M0 tooling and M1 internal PostgreSQL normalization, scalar/entity naming, and declarative naming overrides are implemented for their documented subsets. Direct DBML normalization and entity generation remain pending. This is a maintainer-facing plan kept in the public repository, not a claim of completed generator support. It belongs outside the npm package allowlist.

The current repository contains strict TypeScript/ESM tooling, compiled `node:test` tests, Biome formatting/focused lint, an initial license-metadata inventory, the tested [documentation/vocabulary check](documentation-check.md), and a read-only [Node 24/26 CI workflow](../.github/workflows/ci.yml). The private package remains locked and unpublished. CI runs clean, engine-strict, script-disabled installs and `npm run check`; see the [toolchain guide](toolchain.md). The [fixture corpus](../tests/fixtures/README.md) preserves pinned upstream DBML, independent SQL/DBML pairs, and negative inputs. The internal [PostgreSQL adapter](postgres-normalization.md) normalizes a tested subset without executing SQL; the [naming layer](naming.md) resolves classes, scalar properties, and basenames without changing database semantics. There is no direct DBML normalizer, entity emitter, public library API, CLI, or published package. This is not completed generator support or completion of M2.

## Recommendation and boundaries

Build one framework-neutral npm package in small, testable increments. Finish PostgreSQL SQL DDL and DBML generation with a working NestJS integration before adding MySQL and Aurora MySQL. Add further dialects and RDS Data API support as separately tested capabilities.

Quality means a documented subset with reproducible proof, not a promise to support every database feature. A feature is supported only when its semantics, failure behavior, generated output, and consumer integration have been checked. Unsupported input must fail clearly rather than produce an incomplete result.

Keep the design in [architecture.md](architecture.md), the dated evaluations in [research.md](research.md), and repository rules in [CONTRIBUTING.md](../CONTRIBUTING.md). This plan is the source of truth for implementation order and milestone acceptance. Update all affected documents in the same change when a decision changes.

### First release: required

- PostgreSQL SQL DDL and DBML targeting an explicit PostgreSQL profile.
- A versioned internal relational schema contract; structured, stable diagnostics.
- Decorated TypeORM classes with deterministic naming and physical-name preservation.
- A pure library API and a thin CLI with declarative JSON configuration.
- Complete file planning, ownership/conflict checks, safe writing, `--dry-run`, and `--check`.
- Framework-neutral entities, an explicit entity registry, a tested NestJS example, and an optional NestJS persistence-module preset.
- Independent fixtures, strict generated-project compilation, runtime metadata checks, and disposable PostgreSQL integration tests.
- A tested public npm tarball, contributor setup, support tables, security reporting instructions, and license review.
- TypeORM 1.x, one explicitly tested generated module format, and Node 24/26 test lanes. The project engine floor is `24.11.0`, aligned with the selected TypeORM 1.x requirement; Node 24 LTS is the development default. Recheck dependency requirements during bootstrap. Passing parser checks is not proof of generated-project compatibility.

Aurora PostgreSQL through a native connection is a target profile in this design. Local PostgreSQL tests establish engine-family behavior only. Until a controlled Aurora test passes, label that deployment as compatible in design but not verified on Aurora; do not advertise it as tested support.

### Later: approved sequence

1. MySQL SQL DDL and DBML targeting MySQL, followed by native Aurora MySQL verification.
2. Additional dialects and integrations, each justified by a concrete use case and its own tests.
3. Dedicated RDS Data API compatibility for Aurora PostgreSQL and Aurora MySQL.

Live metadata inspection, relational JSON/YAML input, and `EntitySchema` output can be proposed after the first release. They must not postpone the approved PostgreSQL/NestJS and MySQL work. Their exact priority remains unassigned.

### Not required for the first release

No public plugin framework, monorepo, service container, executable configuration, user templates, arbitrary schema migration runner, cross-database schema translator, or generated CRUD/API layer. Do not generate application authorization, validation rules, or persistence cascades from a database schema. Do not claim universal document/key-value database support.

TypeORM 0.3, CommonJS output, native Prisma/Drizzle parsers, YAML configuration, diagram imports, and performance dashboards are deferred until a tested consumer requirement justifies them.

## Ownership and change control

These are roles, not additional staffing requirements. One maintainer may perform every role. Implementation milestones are unassigned until a maintainer or contributor takes one; the repository maintainer is the default accountable owner.

| Role | Responsibility |
| --- | --- |
| Repository maintainer | Accept scope, maintain support claims, review public API/schema changes, and decide whether a milestone passes |
| Implementation owner | Deliver a bounded change with tests, documentation, and reproducible check output |
| Reviewer | Check semantics and failure paths independently; challenge the implementation's assumptions rather than approving snapshots alone |
| Release owner | Verify package ownership, license/security findings, tarball behavior, release notes, and the publishing checklist |

Start each work item with an owner, milestone, dependencies, supported subset, acceptance criteria, and exclusions. Use small issues and pull requests instead of a parallel project-management system. A bug fix should include the smallest reproducing fixture.

Schema-contract or public-API changes need a short rationale in the pull request. Add a separate decision note only for a lasting cross-cutting decision; do not require one for every helper. Keep the public surface narrower than the internal implementation.

No document authorizes a commit, push, service restart, infrastructure creation, or publication. Those actions require the owner's explicit request. Published releases also require a separate release decision after their checks pass.

## Architecture to implement

### Separate schema and runtime choices

| Concern | Meaning | Example |
| --- | --- | --- |
| Input format | How schema information is encoded | SQL or DBML |
| Source dialect | How source types and expressions are interpreted | PostgreSQL DDL |
| Target database | Engine family, version/capabilities, and optional deployment restrictions | PostgreSQL on Aurora |
| Runtime profile | Tested TypeORM output semantics and value mappings; connection transport for integration examples | TypeORM 1.x with a native PostgreSQL connection |
| Output integration | Additional consumer files, without changing schema meaning | Plain TypeORM or NestJS |

For the first release, SQL dialect and target engine must agree. DBML must declare its target engine. A different source and target is a validation error, not an implicit translation request.

Aurora is not a standalone SQL dialect. Native Aurora PostgreSQL uses the PostgreSQL connection profile; native Aurora MySQL uses the MySQL profile. The TypeORM `aurora-postgres` and `aurora-mysql` connection types are Data API profiles, not defaults for every Aurora deployment. Serverless/provisioned deployment does not by itself choose the transport.

Connection hosts, writer/reader routing, certificates, authentication, IAM settings, pooling, and credentials belong to application configuration. Ordinary generation must not connect to a database or require NestJS, TypeORM, AWS SDKs, or database drivers at runtime. Those dependencies belong in test consumers or separately loaded inspection integrations.

A database profile contains the type mappings and capability rules actually used by the implementation. Start with small typed functions and data tables. Do not build a capability-rule language or enumerate every future engine feature in advance. Introduce model fields with tested behavior; retain or diagnose unsupported details rather than discarding them.

### Proposed layout

This layout is a guide, not a requirement to create empty directories.

```text
src/
  schema/              contract, diagnostics, validation
  adapters/            PostgreSQL SQL and DBML normalization
  targets/             database capabilities and type/value mappings
  resolve/             names, keys, relationships
  emit/                TypeORM output; optional NestJS companion files
  files/               file plans, manifests, conflicts, writer
  cli/                 argument/config parsing and diagnostic presentation
  index.ts             deliberately small public library entry point
tests/
  fixtures/            independent source and expected schema facts
  unit/                observable conversion and diagnostic behavior
  integration/         metadata, database, NestJS, and CLI checks
  package/             installed-tarball consumer tests
examples/
  nestjs/              minimal checked consumer example
docs/                  design, support tables, guides, release checklist
scripts/               small portable test/document/package helpers
.github/               pull-request checks and contribution templates
```

The CLI calls library functions; it does not maintain a second conversion path. Emitters consume resolved schema data, not parser ASTs. Keep generated entity definitions independent of NestJS. Use the same explicit registry for TypeORM configuration, NestJS registration, and test consumers.

## Milestones and dependencies

Each milestone ends with a reviewable result. Do not start a dependent milestone while its prerequisite's semantic acceptance remains unresolved. Packaging and documentation checks become stricter as functionality becomes available, rather than being saved for the end.

### M0 — Reproducible development foundation

**Owner:** repository maintainer. **Depends on:** this plan. **Release requirement:** yes.

Deliver:

- A development-only package manifest, lockfile, strict TypeScript build, ESM library layout, and explicit Node engine floor. Keep `private: true` until the release checklist and package name are settled.
- `node:test` against compiled TypeScript, a formatter, and one focused lint configuration. Avoid another source-transformation stack, mandatory commit hooks, or duplicate lint tools.
- A small documentation check for local links, vocabulary rules, and example references. Exempt required third-party legal notices; review generated fixtures too.
- `npm run check` and `npm test` are implemented; see the [toolchain guide](toolchain.md) for exact current behavior. `npm run test:integration` and `npm run test:package` remain future commands, not installed scripts.
- A minimal pull-request CI workflow using clean installs on Node 24/26, with the minimum supported Node 24 patch checked when runtime requirements change. Separate fast checks from Docker-backed integration checks and later cloud checks. No release credentials or cloud credentials in pull-request jobs.
- A first independent schema fixture and its failing behavior test as the entry point to M1.

Acceptance:

- A fresh clone installs from the lockfile and runs the documented setup on both supported Node lanes.
- The bootstrap checks pass. The initial behavior test demonstrably fails for the intended missing behavior before implementation; do not leave the default branch deliberately failing.
- Commands work without credentials. Toolchain versions and engine floors are recorded; installed dependencies have an initial license inventory.

### M1 — Shared schema contract and PostgreSQL normalization

**Owner:** schema implementation owner; maintainer reviews the contract. **Depends on:** M0. **Release requirement:** yes.

Deliver:

- Contract version, source locations, literal/expression defaults, physical identifiers, generation strategies, keys, relationships, and structured diagnostics as needed by the supported subset.
- The PostgreSQL SQL adapter using the evaluated parser behind an internal boundary. Interpret supported DDL in source order without executing it.
- Deterministic naming and collision detection, with explicit overrides. No default singularization or foreign-key inference from names.
  - Implemented internal rules and tests are in the [naming guide](naming.md). Relation/enum names and emitter symbol conflicts belong to M3.
- A statement/feature support table mapping every accepted operation to fixtures. Unknown types, directives, and schema mutations must fail before a writable result is returned.

Acceptance:

- Independent fixtures cover basic tables/types, nullability, defaults, precision/scale, keys, constraints, schemas, enums, identity, and the documented `ALTER TABLE` subset.
- Every schema feature outside the subset has a clear diagnostic path. Include generated expressions, arrays, partial/expression indexes, quoted identifiers, duplicate objects, and invalid references in coverage even if a feature is rejected initially.
- Test normalization facts, source ordering, and diagnostics, not just parser acceptance. Bound input size/object count and test oversized input; choose parser cancellation/isolation from measured behavior rather than speculative worker infrastructure.

### M2 — DBML normalization and fidelity rules

**Owner:** adapter implementation owner. **Depends on:** M1. **Release requirement:** yes.

Deliver:

- A direct DBML-to-contract adapter using the evaluated parser mode, with PostgreSQL target validation.
- Explicit rules for reference direction, composite pairs, defaults, enum references, and declared uniqueness.
- Diagnostics for conceptual many-to-many relationships without a physical junction table, unknown types, and nonrepresentable semantics. Source notes are not copied into generated output.

Acceptance:

- Equivalent SQL and DBML fixtures produce matching physical schema facts for their common supported subset.
- Composite references, one-to-one qualification, self-references, and missing targets have independent positive/negative cases.
- Known SQL-to-DBML fidelity losses remain regression cases; the implementation never uses that lossy conversion as its shared model.

### M3 — TypeORM emission and PostgreSQL proof

**Owner:** emitter implementation owner; reviewer checks database semantics. **Depends on:** M1 and M2. **Release requirement:** yes.

Deliver:

- A pure generation result containing planned files and diagnostics, with a decorated-class emitter and explicit entity registry.
- Tested mappings for names, nullability, precision-sensitive values, defaults, generation, keys, and relationships. Keep scalar foreign-key properties; keep junction tables explicit by default.
- Strict fidelity validation for the selected TypeORM/database profile. Known externally managed features require explicit exclusions, reported in the result and support table.
- Disposable PostgreSQL tests comparing controlled source schema catalog facts with generated TypeORM metadata and, where useful, schema-diff results.

Acceptance:

- Generated projects compile with strict settings and execute under the declared module format. Check public/consumer types without hiding defects behind `skipLibCheck`.
- Runtime metadata matches independently specified facts. Test composite keys, cycles, multiple foreign keys to one target, and nullable relations; eager/lazy loading and persistence cascades stay off by default.
- Run controlled database comparisons for every accepted fidelity feature. Fixture setup may execute repository-controlled SQL only in disposable test databases; the generator never executes input SQL.
- Repeated conversions produce identical file paths and bytes with no timestamps or absolute paths. Golden files are secondary proof, not the semantic oracle.

### M4 — CLI and safe output

**Owner:** CLI/writer implementation owner. **Depends on:** M3. **Release requirement:** yes.

Deliver:

- Thin CLI, JSON configuration with documented precedence, stable exit behavior, human/machine-readable diagnostics, help, and version output.
- A complete file plan, ownership/content-hash manifest, destination preflight, staged writes, an output-root lock, and minimal recoverable state for interrupted runs.
- Conflict-safe repeat generation and removal of stale owned files; `--dry-run` and `--check` never mutate files. Refuse hand-edited and unrelated output.

Acceptance:

- CLI tests exercise invalid input, fidelity errors, output conflicts, unchanged output, changed output, and successful generation. Library and CLI results agree.
- Byte/hash checks prove nonmutating modes do not change files. Invalid input must create no output directory, manifest, or partial entities.
- Adversarial tests cover traversal, symlink escapes, case-folding collisions, malformed manifests, concurrent runs, caught write failures, and interrupted recovery. Reject unsupported path/platform situations rather than offering unverified safety.
- Do not claim atomic multi-file replacement: per-file rename is not a transaction. Recovery leaves owned output consistent or reports a recoverable failure without damaging unrelated files.

### M5 — NestJS preset and consumer example

**Owner:** integration implementation owner. **Depends on:** M3 and M4. **Release requirement:** yes.

Deliver:

- A minimal NestJS example using the ordinary generated TypeORM entities and explicit registry, plus an optional generated persistence module.
- A consistent connection-name option across `forFeature`, root configuration examples, and repository injection. Root connection settings remain application-owned.
- Documentation for `forRoot`/`forRootAsync`, repository injection, migrations, `synchronize: false`, and the limitations of entity auto-loading.

Acceptance:

- An actual decorated-entity fixture compiles, starts a Nest application context, resolves named repository injection, and shuts down cleanly. Test an unnamed/default connection as well.
- A disposable PostgreSQL-backed consumer test persists/reads controlled values through the injected repository and checks precision/nullability and a relationship.
- The same entities work without NestJS. Choosing the NestJS preset adds companion files only; it does not change schema semantics or add NestJS runtime dependencies to the generator.
- Register relation targets explicitly; do not assume auto-loading will find relation-only entities. Examples contain no secrets or automatic schema synchronization.

### M6 — First public package readiness

**Owner:** release owner; maintainer accepts readiness. **Depends on:** M0–M5. **Release requirement:** yes.

Deliver:

- Final package name after scope verification, typed exports, executable CLI entry, MIT metadata, public access configuration, and a strict package-file allowlist.
- An installed-tarball test including parser runtime/WebAssembly assets, generation, library import, CLI help/errors, NestJS output, and repeat/check behavior.
- Working quickstart, CLI/API/config reference, statement/type support tables, diagnostics/troubleshooting, tested compatibility table, contributor guide, changelog, security policy, and release checklist.
- Issue and pull-request templates requesting a minimal reproduction, target/runtime versions, tests, and documentation impact. Never request real credentials or production dumps.
- Direct/transitive license review and dependency security triage; separately configured npm trusted publishing when the owner authorizes release setup.

Acceptance:

- Install a local tarball in a fresh directory outside the source tree. The package works without source-tree assets or undeclared dependencies.
- Quickstart commands and examples are executed against that tarball. Published examples are tested artifacts, not unverified snippets.
- Every support claim lists its fixtures, exact tested versions, transport, and evidence status. Planned/engine-family-tested/cloud-tested remain distinct.
- No secrets, customer schemas, internal-plan file, scratch output, tests, or unnecessary development assets enter the tarball. Required notices are retained.
- No unresolved correctness/data-loss/security blockers; dependency findings have severity, exposure, and a recorded fix or mitigation reviewed by the maintainer. Do not suppress failures silently.
- Publishing remains blocked until npm ownership and trusted-publisher configuration are verified and the owner requests release. Readiness is not publication.

### M7 — MySQL and native Aurora coverage

**Owner:** database adapter implementation owner. **Depends on:** M6 readiness. **Release requirement:** next capability release, not the PostgreSQL first release.

Deliver:

- MySQL SQL and DBML target support through the existing internal boundaries. Evaluate the SQL parser on independent MySQL fixtures before choosing it; do not infer fidelity from PostgreSQL results.
- MySQL capabilities and mappings for generated columns, auto-increment, decimal/bigint values, JSON, enum behavior, collation, default expressions, and relationships. Explicitly reject PostgreSQL-only details and invalid foreign-key targets.
- Disposable MySQL comparisons and tests of driver value handling. Add native Aurora PostgreSQL/MySQL deployment checks only in owner-provided, isolated test infrastructure.

Acceptance:

- Meet the same semantic, compilation, metadata, writer, package, and documentation gates as PostgreSQL without changing PostgreSQL behavior.
- Native Aurora evidence records engine version, transport, controlled fixture results, and limitations. Local engine tests must not be presented as Aurora tests.
- Cloud checks use restricted credentials and bounded resource/time budgets; they are manual protected checks, never required from fork contributors. If infrastructure is unavailable, leave cloud support unverified rather than claiming success.

### M8 — Further integrations and Data API

**Owner:** maintainer assigns one bounded integration at a time. **Depends on:** M7. **Release requirement:** only for the capability being advertised.

Deliver:

- Add further dialects one at a time using their own support tables, negative cases, and disposable database comparisons.
- Later Data API profiles use optional test dependencies and controlled AWS integration tests for each engine. Check transaction behavior, parameter/value encoding, precision/nullability, unsupported types, response limits, and error handling.
- Recheck Region/engine availability and AWS restrictions at implementation time. Data API uses writer instances and has its own limits; native transport evidence is insufficient.

Acceptance:

- A new profile passes existing regression tests and its own metadata/value/consumer tests. Update only the claimed rows of the compatibility table.
- Mocked responses and driver-construction checks are useful but do not prove live Data API behavior. Cloud tests and access requirements are explicit.
- A public extension API is introduced only if multiple real integrations cannot be maintained cleanly through the current internal modules. Document and test any public extension contract before release.

## Tooling and test policy

The table records current fast checks and future integration/package acceptance gates. Do not invoke the future commands as if they already existed.

| Command/check | Scope | Required when |
| --- | --- | --- |
| `npm run check` (implemented) | Formatting/lint, strict type/build checks, documentation/vocabulary, license metadata, and all current tests | Every pull request |
| `npm test` (implemented) | Parser and documentation regressions, compiled normalization/naming, and tooling tests; output/writer tests follow their features | Every behavior change |
| `npm run test:integration` (future) | Metadata, module execution, CLI, NestJS, disposable database comparisons | Affected integrations; required CI before accepting support |
| `npm run test:package` (future) | Build/pack, archive inspection, fresh installation, CLI/library consumers and documented examples | Package/runtime changes and release readiness |
| Manual protected cloud check | Controlled native Aurora or Data API fixtures | Before advertising a cloud-specific compatibility row |

Use Docker-backed disposable services for local database tests; document ports, setup, cleanup, and a way to select existing disposable services without production defaults. Keep test execution portable through Node helpers rather than shell-specific command chains. Do not require AWS access for the standard contributor workflow.

CI must be read-only for pull requests, must not publish, and must not execute untrusted fork changes in a credentialed context. Use least permissions and pin external workflow actions to reviewed revisions. Required jobs cannot silently skip a missing database or treat an unavailable service as a pass.

Tests follow behavior-first development: show a failing case, implement the smallest complete behavior, then run the narrowest relevant checks. Full required CI/release gates remain mandatory at merge/release. Cover every public diagnostic code and supported schema feature with positive/negative fixtures as appropriate; report coverage but do not substitute a percentage for semantic proof.

Record fixture expectations independently from the generator. Do not update snapshots to make a regression pass without explaining the changed database semantics. Use bounded failure and deterministic randomized cases where they reveal real risks; defer expensive fuzzing/benchmark infrastructure until measurements justify it.

## Documentation and contributor extension checklist

Create support/compatibility references as the corresponding features are implemented. README remains the user entry point; this plan remains a maintainer roadmap. Internal does not mean secret: no private infrastructure details or credentials belong here.

For every new adapter, target, or emitter:

1. Name the input/target subset and explicitly list exclusions before implementation.
2. Add an independent success fixture and a meaningful failure fixture; include edge cases specific to the database.
3. Normalize through the shared contract and diagnostics; keep parsing, resolution, emission, and I/O separate.
4. Reuse existing file-safety and consumer tests instead of adding a parallel pipeline.
5. Add strict compilation, runtime metadata, and database/transport tests appropriate to the new support claim.
6. Update support tables, examples, diagnostics, compatibility evidence, and changelog in the same pull request.
7. Review vocabulary, dependency size/license/security impact, and the installed tarball. Export no new public symbol without a concrete consumer need.

Document contributor prerequisites, quick/slow checks, how to add fixtures, how to reproduce a diagnostic, and how to report security issues privately through a verified maintainer channel. Do not invent a contact address. A change is not complete while documentation still advertises planned behavior as implemented behavior.

## Risks and concrete blockers

| Risk or dependency | Response | Blocks |
| --- | --- | --- |
| Parser accepts syntax whose semantics are unsupported | Statement/feature allowlists, independent facts, no output on fidelity errors | Accepting that syntax |
| TypeORM cannot express a source constraint/index exactly | Error by default; explicit external-management exclusion only when documented and tested | Faithful support claim |
| Compiler/module behavior changes or cyclic relation imports break | Lock versions, compile and execute generated consumers, recheck upgrades | Supported runtime profile |
| Writer interruption or concurrent changes damage output | Ownership hashes, preflight, lock, staged recovery, adversarial tests | CLI release readiness |
| Database feature availability varies by engine/version/transport | Small versioned profiles and exact evidence rows | New compatibility claim |
| Aurora test infrastructure and credentials are absent | Keep local and cloud proof separate; use owner-provided isolated infrastructure later | Verified Aurora/Data API support, not local development |
| npm scope ownership or trusted publishing is unverified | Verify during release readiness; keep development manifest private | Publication, not implementation |
| New dependencies have notice/security obligations | Inventory and review actual installed/packed dependency set | Release until addressed |
| Extension work expands scope prematurely | One capability per change; reuse internal boundaries; defer public plugin/API work | Nothing unless a concrete integration needs a new boundary |

## Definition of done and next action

A milestone is done when its deliverables exist, its acceptance checks pass reproducibly, the reviewer can trace support claims to evidence, and affected documentation is current. An approved plan or a temporary research sample does not satisfy these gates.

**Next action:** assign M0 to the repository maintainer, create the reproducible development toolchain, and add the first independent PostgreSQL behavior fixture before implementing the schema contract. There is no known blocker to local M0 work. npm ownership and AWS access block only later publication and cloud verification; they must not block ordinary contributor tests.

## Source-backed design notes

Initial research was recorded on **2026-10-09**; Aurora Data API limitations and NestJS integration documentation were rechecked on **2026-10-10**. Recheck moving documentation and dependency versions when implementing a profile.

- [Aurora engine overview](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html): distinguishes MySQL- and PostgreSQL-compatible deployments.
- [TypeORM PostgreSQL driver](https://typeorm.io/docs/drivers/postgres/) and [MySQL driver](https://typeorm.io/docs/drivers/mysql/): native connection and database-specific options.
- [RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html), [limitations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html), and [availability](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.regions.html): a distinct transport with deployment restrictions.
- [NestJS TypeORM integration](https://docs.nestjs.com/data/typeorm) and [published adapter metadata](https://registry.npmjs.org/@nestjs%2ftypeorm/12.0.2): standard entities, repository registration, and declared peer ranges. Declared compatibility is a starting point for consumer tests, not proof of our generated output.
- [Research record](research.md): parser evaluation, TypeScript emission adjustment, dependency/license observations, and initial package constraints. These are dated observations, not committed regression tests.
