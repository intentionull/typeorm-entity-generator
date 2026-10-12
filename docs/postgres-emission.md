# PostgreSQL entity emission

The internal [`emitPostgresEntities(resolved)`](../src/emit/postgres.ts) function accepts the result of [naming resolution](naming.md) over a version-1 PostgreSQL schema. It returns a deterministic [file plan](../src/emit/model.ts), not files on disk. It neither executes input SQL nor connects to a database. This is an internal development interface, not a published package API.

The first profile targets decorated TypeORM 1.x entities, tested against **TypeORM 1.1.2**, strict **TypeScript 7.0.2**, ESM/NodeNext, and **PostgreSQL 18.4**. These pinned versions are test evidence, not a promise about every TypeORM 1.x or PostgreSQL release. MySQL, NestJS integration, persistence, native Aurora deployment and Data API transport remain separate milestones.

## Result and files

- Success is `{ ok: true, files, diagnostics: [] }`; each file has a relative `path` and string `content`.
- Failure is `{ ok: false, diagnostics }`, with no partial file plan. Errors include source locations and physical object selectors where available.
- Each mapped table produces its selected `.entity.ts` basename and exported class. `index.ts` re-exports the classes and exports an explicit `entities` array, including an empty array for an empty schema.
- Generated imports use `.js` extensions for compiled ESM. Output has no timestamps, absolute checkout paths, connection settings or synchronization calls.
- Generation preserves its input and keeps no state between calls. Modifying a returned plan does not affect later results.
- The caller owns writing and consumer configuration. Until the safe writer exists, this result makes no overwrite, regeneration or crash-recovery guarantee.

## Supported mapping

| Physical fact | Generated representation | Evidence |
| --- | --- | --- |
| Schema/table/column names | Explicit `Entity` and column names, separate from generated identifiers | Application metadata and SQL/DBML pair catalogs, including quoted mixed-case names |
| Nullability | Explicit column options and nullable property types | All five application metadata/catalog cases and focused SQL |
| `int2`, `int4`, `float4`, `float8` | `number` properties with explicit physical type | Strict consumer types and physical catalogs |
| `int8`, `numeric` | `string` properties; numeric precision/scale preserved, without number coercion | Strict consumer types; focused large numeric default, unbounded/single-modifier numeric and negative scale catalog cases |
| `bool`; `text`, `varchar`, bounded `bpchar`, `uuid` | Boolean or string properties; physical type/length options | Strict consumers and physical catalogs; `bpchar(n)` uses TypeORM's `character` spelling |
| `date`, `time`, `timetz` | String properties with physical types and time precision | Strict consumer types and catalogs |
| `timestamp`, `timestamptz` | `Date` properties with physical types and precision, including zero | Strict consumer types, focused metadata and catalogs |
| `bytea`; `json`, `jsonb` | `Buffer` or `unknown` properties with explicit physical types | Strict consumer types, application/focused metadata and catalogs |
| Same-schema enums | Literal string-union properties, explicit labels and enum name | Application and focused metadata/catalog cases, including escaped labels |
| Supported literal/expression defaults | SQL-returning default callbacks; strings escaped and numeric text retained | Application/focused metadata and catalogs |
| Primary keys | `PrimaryColumn`; optional explicit constraint name | Application/focused metadata and catalogs |
| Primary-key identity | `PrimaryGeneratedColumn('identity', ...)`, `ALWAYS` or `BY DEFAULT` | Focused consumer metadata and catalogs |
| Unique constraints | `Unique`, retaining ordered columns and optional names | Application metadata/catalogs |
| Named plain btree indexes | `Index`, preserving order and uniqueness | SQL/DBML pair/application catalogs and focused unique-index references |
| Foreign keys | Standalone `ForeignKey`, ordered local/target property arrays, supported actions and deferrability | Application metadata/catalogs, focused reversed target order and all 16 supported update/delete action pairs; nine `SET DEFAULT` pairs rejected |
| Declared relationships | Unidirectional `ManyToOne` or `OneToOne`; scalar FK properties retained | Strict application consumers, independent relation metadata and catalog checks for extra constraints |

Property types describe the default driver-facing representation. They do not establish round-trip value fidelity, timezone behavior, persistence semantics or compatibility with custom driver parsers/transformers. Those require persistence tests.

## Relationships and upstream limitations

Each declared foreign key gets a deterministic table-local property `relation1`, `relation2`, and so on in foreign-key order. An exact local primary/unique key or unique index qualifies a one-to-one relation; otherwise it is many-to-one. No inverse relations, inferred junctions, name-based relationships, eager loading, lazy loading or persistence cascades are added. Nullable joins produce nullable relation types.

Standalone foreign-key decorators retain physical constraint order. Relation decorators set `createForeignKeyConstraints: false` so they cannot infer additional keys or uniqueness. This separation is deliberate: the pinned relation builder sorts composite referenced columns and can otherwise add an implicit one-to-one unique constraint. Tests check explicit constraint order, relation column pairings, and absence of extra physical constraints. This use of both decorators is specific to the tested profile; upstream documentation warns against combining them when relations create their own constraints.

Imports use private collision-safe aliases. The class name `entities` conflicts with the registry export and requires an explicit naming override. A scalar property colliding with `relationN` also needs a scalar naming override; the emitter does not silently rename it. Relation naming overrides are not yet supported. Enum labels stay inline, so no separate runtime enum symbol is invented.

## Rejections

Normalization acceptance does not imply emission acceptance. The emitter rejects:

- Tables without an explicit primary key, or primary-key order differing from the physical order of its member columns.
- Identity generation on non-primary columns.
- Unbounded physical `bpchar`: TypeORM would narrow it to `character(1)`.
- Cross-schema enum references, unused enums, and unused non-public namespaces, rather than silently losing them.
- `MATCH FULL` and relations whose local/target physical types or modifiers differ; the pinned relation builder can change scalar metadata.
- `SET DEFAULT` on either foreign-key action: the pinned TypeORM option declarations accept `DEFAULT` rather than PostgreSQL's `SET DEFAULT`. Strict compilation fails for the correct spelling. This profile rejects all nine affected action pairs instead of changing the action, casting it away or suppressing type checking. Normalization still supports all 25 action pairs.
- Physical identifiers containing a dot, quote or backslash at the supported name sites. Quoted identifiers without those characters can be preserved.
- Registry/relation property collisions and incomplete or inconsistent naming mappings.

`EMIT_UNSUPPORTED` identifies a profile fidelity limitation; `EMIT_COLLISION` identifies a generated-name conflict; `EMIT_INVALID` identifies inconsistent internal mappings. The function expects normalized, resolved internal data; it is not a validator for arbitrary public schema objects. Unsupported constructs rejected by the [SQL](postgres-normalization.md) or [DBML](dbml-normalization.md) adapter never reach it.

## Consumers

Consumers must enable legacy decorators and their metadata, use strict NodeNext/ESM compilation, and provide TypeORM and the applicable driver. Tests compile with `skipLibCheck: false`, `noUnusedLocals`, `noUnusedParameters`, declarations and no runtime source loader. Entity files have no NestJS dependency. The registry can serve a normal TypeORM `entities` option; actual NestJS registration and persistence verification belong to M5.

## Catalog tests

```sh
npm run test:emission
SCHEMA_TEST_HOST=127.0.0.1 SCHEMA_TEST_PORT=5432 SCHEMA_TEST_USER=postgres npm run test:catalog
```

Use **disposable local PostgreSQL only**, with a test role able to create databases. The integration command refuses an absent host or a host other than `127.0.0.1` or a `/tmp/` Unix socket. Each case creates uniquely named source/generated databases and drops only those databases in cleanup. No production connection configuration is read. The database-free `npm run check` does not run this integration file; CI runs it explicitly in both Node lanes using a digest-pinned PostgreSQL service bound to loopback. That ephemeral service uses local trust authentication and is not a deployment configuration.

The [catalog tests](../tests/emission.catalog.ts) execute repository-controlled SQL for the three [SQL/DBML pairs](../tests/fixtures/pairs/), plus focused SQL and all five [application fixtures](../tests/fixtures/applications/). For applications, test-only [DDL construction](../tests/emission-catalog-oracle.ts) uses the pre-existing handwritten schema expectations, not parsed input, adapter output or emitter helpers. Source and generated catalogs must match ordered physical column types/modifiers, nullability, defaults, identity modes, keys/references/actions/deferrability, standalone indexes, enum names/labels and namespaces.

Two boundaries are explicit:

1. Implicit constraint names are not compared; explicitly declared names are. Index names and ordered key columns remain compared.
2. The consumer provisions non-public namespaces before synchronization because entity decorators do not create namespaces. Unused namespaces are rejected, not treated as an exclusion.

Synchronization occurs only in disposable integration setup. Generated files never enable it. Passing these comparisons is bounded schema-fidelity evidence, not a recommendation to synchronize production schemas or a substitute for migration review.

The independent [metadata tests](../tests/emission-consumer.test.ts) and [file-plan/rejection tests](../tests/emission.test.ts) complement the database oracle. No single fixture suite establishes every possible schema combination. Maintainer acceptance, public API/package gates, safe writing, NestJS/persistence and cloud evidence remain separate.
