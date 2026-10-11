# DBML coverage matrix

This matrix tracks the bounded [DBML normalization profile](dbml-normalization.md), not every construct accepted by the DBML parser. Each supported feature needs independently specified physical facts; each unsupported feature needs a structured rejection without a partial schema. Combinations matter more than a high line-coverage percentage.

## Evidence layers

- [Upstream originals](../tests/fixtures/upstream/manifest.json): parser/provenance tests only. Preserve their bytes, hashes, licenses, and attribution. Parser acceptance does not imply normalization acceptance.
- [Three SQL/DBML pairs](../tests/fixtures/pairs/): independently authored inputs, literal parser-level assertions, and normalized cross-adapter equality. Equality alone could reproduce a shared mistake.
- [Application fixtures](../tests/fixtures/applications/): locally authored MIT examples for commerce, tenancy, permissions, content, and scheduling. [Handwritten expectations](../tests/dbml-application-expectations.ts) specify the complete physical schema; their helpers construct contract objects and parse no source. These are representative examples, not imports from deployed applications.
- [Combination tests](../tests/dbml-combinations.test.ts): independently expected type mappings, modifier boundaries, compatibility rules, and the 25 update/delete action pairs on nullable composite references with cycles and cross-schema targets.
- [Generated tests](../tests/dbml-generated.test.ts): three fixed seeds, 12 cases each, known physical-schema oracles, and invalid collision mutations. No random source, converter snapshot, network, credentials, or database is involved.
- [Boundary tests](../tests/dbml-boundaries.test.ts) and [retained regressions](../tests/fixtures/regressions/): exact resource ceilings and reduced failures. Invalid grammar used to isolate lexical limits is not a positive normalization fixture.

## Supported features

The tests listed here compare physical facts or explicit properties, not merely `ok: true`. All test paths are relative to the repository's `tests/` directory.

| Documented feature | Expected physical facts | Test evidence |
| --- | --- | --- |
| Explicit PostgreSQL target and project | PostgreSQL dialect only; no inferred engine | `dbml.test.ts`: matching-engine tests; application oracles |
| Default/explicit namespaces and forward declarations | `public` plus declared namespaces; qualified enums and references resolved without reordering | `dbml.test.ts`; content/tenancy oracles; generated full-schema cases |
| Table, column, enum, and reference order | Declaration order retained; mixed standalone and inline reference order retained | `dbml.test.ts`; generated full-schema cases vary table/reference order |
| Quoted names and table aliases | Decoded physical names, including escaped quote/backslash and multibyte text; aliases only resolve references | `dbml.test.ts`; content oracle; generated full-schema cases |
| Nullable/default columns and primary-key nullability | Omitted nullability is nullable; primary-key columns are non-null; default categories remain distinct | `dbml.test.ts`; application oracles; composite action matrix |
| Every supported scalar spelling | Catalog name and modifiers, including uppercase variants; no guessed type | `dbml-combinations.test.ts`: scalar spelling matrix; `dbml.test.ts`: qualified names |
| Modifier endpoints | Character length 1/10485760; precision 1/1000; scale -1000/1000; temporal precision 0/6 | `dbml-combinations.test.ts`: accepted boundary matrix |
| Enums | Qualified identity, ordered labels, empty individual label allowed; enums named `json` remain enums | `dbml.test.ts`; application oracles; generated escaped enum labels |
| Strings, booleans, null and expressions | Distinct default tags; expressions remain unevaluated text | `dbml.test.ts`; commerce/scheduling oracles; generated escaped strings |
| Numeric defaults | Exact signed/exponent/large-number spelling, not rounded JavaScript numbers | `dbml.test.ts`; generated full-schema cases, including notes containing false default tokens |
| Primary and unique keys | Column flags and composite indexes become keys, without inferred names | `dbml.test.ts`; commerce/tenancy/permissions oracles |
| Physical btree indexes | Named ordered columns; explicit unique btree remains an index, not a unique constraint | `dbml.test.ts`; commerce/content/scheduling oracles; structural budget case |
| Standalone/inline `>` and `<` | Foreign-key direction and local/target column order | `dbml.test.ts`; generated mixed-direction references |
| Candidate keys and one-to-one `-` | Explicit target uniqueness; explicit local uniqueness for one-to-one; no inferred constraints | `dbml.test.ts`; commerce/permissions oracles |
| Nullable composite, self, circular and cross-schema references | Ordered composite pairs, correct qualified targets, nullable local columns, cycles preserved | All five application oracles; 25 composite circular action cases |
| Every update/delete action combination | Exact action pair; simple match, nondeferrable; absent actions are `no action` | `dbml-combinations.test.ts`: all 25 pairs and default-action assertions |
| Foreign-key type families | Identical supported types, all integer-family pairs, all text/varchar pairs; enums require qualified identity | `dbml-combinations.test.ts`; `dbml.test.ts`: enum/self/composite cases |
| Presentation-only data | Notes, colors and groups add no physical facts; their bytes/tokens still count | `dbml.test.ts`; opaque-input and structural-budget cases |
| Determinism and per-call ownership | Identical facts/locations on repeat calls; result mutation cannot affect later calls; failure recovery | `dbml.test.ts`; application repeated calls; generated mutation/isolation assertions |
| Source locations | UTF-8 byte offsets and one-based UTF-16 columns; synthetic composite-key fallback | `dbml.test.ts`; exact scanner boundary locations |

## Rejections and resource boundaries

| Feature or boundary | Expected result | Test evidence |
| --- | --- | --- |
| Missing/conflicting project engine | `DBML_DIALECT` | `dbml.test.ts` |
| Invalid target/options, malformed Unicode, NUL | `DBML_OPTIONS` | `dbml.test.ts`; inclusive option endpoints in `dbml-boundaries.test.ts` |
| Byte ceiling | Exact configured/default/maximum ceilings accepted; one UTF-8 byte over yields `DBML_LIMIT` | `dbml-boundaries.test.ts`: 257, 1048576, 8388608 bytes |
| Structural ceiling | Exact mixed-object count 19 accepted/18 rejected; default 10000 accepted/10001 rejected | `dbml-boundaries.test.ts`; counts include initial namespace, labels, keys, indexes and references |
| Object option ceiling | 1 and 100000 accepted as options; 0/100001/fractions/nonfinite numbers rejected | `dbml-boundaries.test.ts`; maximum-sized 100000-object corpus is not asserted |
| Lexical tokens and nesting | Exactly `maxObjects * 32 + 1024` tokens and depth 64 reach parsing; one over yields `DBML_LIMIT` | `dbml-boundaries.test.ts`; intentionally invalid punctuation isolates scanner rejection |
| Identifier/enum-label bytes | 63 bytes accepted; 64 rejected for ASCII, multibyte and astral Unicode | `dbml-boundaries.test.ts`: namespaces, tables, columns, enums, labels, indexes, references |
| Length/precision/scale endpoints | Just outside the supported modifier ranges yields `DBML_INVALID` | `dbml-combinations.test.ts`: rejected boundary matrix |
| Unsupported modifiers or type spellings | `DBML_UNSUPPORTED` for unsupported arity/forms; `DBML_INVALID` for invalid supported modifiers | `dbml.test.ts`; modifier matrix |
| Arrays, domains, serial and unknown scalar types | `DBML_UNSUPPORTED`; no substituted type/generation | `dbml.test.ts`; `dbml-rejections.test.ts` |
| Increment and checks | `DBML_UNSUPPORTED`; no serial/identity or check inference | `dbml.test.ts` |
| Expression/non-btree/unnamed non-constraint indexes | `DBML_UNSUPPORTED` | `dbml.test.ts` |
| Builtin JSON comparisons | `DBML_INVALID` at primary/unique/index comparison sites; JSONB and enums named `json` permitted | `dbml.test.ts`; `dbml-rejections.test.ts` |
| Multiple/nullable/invalid keys | `DBML_INVALID`, or `DBML_SYNTAX` when the compiler catches the invalid declaration first | `dbml.test.ts`; duplicate-column/missing-index-column rejections |
| Missing target, wrong arity/duplicate columns, nonunique target, mismatched types | Rejection without partial schema; compiler catches some invalid endpoints first | `dbml.test.ts`; incompatible-family and distinct-enum cases |
| One-to-one without explicit uniqueness | `DBML_INVALID`; no synthesized key | `dbml.test.ts` |
| Implicit many-to-many and inactive references | `DBML_UNSUPPORTED`; explicit junction fixtures remain positive | `dbml.test.ts`; permissions oracle |
| Duplicate names and relation/constraint collisions | `DBML_SYNTAX` or `DBML_INVALID`; no generated suffix | `dbml.test.ts`; generated table, enum and index collisions |
| Table partials and records | `DBML_UNSUPPORTED` for the tested parsed forms | `dbml.test.ts`; `dbml-rejections.test.ts` |
| Dependencies and external input forms | `DBML_SYNTAX` for the tested unsupported syntax forms; not an assertion that every spelling reaches adapter validation | `dbml-rejections.test.ts` |
| Custom project/table/column physical metadata | `DBML_UNSUPPORTED` for parsed string-valued settings; no silent discard | `dbml.test.ts`; `dbml-rejections.test.ts` |
| Leading-dot numeric default and separately lined reference settings | `DBML_SYNTAX` with the pinned parser | Retained fixtures and `dbml-rejections.test.ts` |

`DBML_PARSER` reports unexpected runtime/upstream contract failures, not a supported user syntax category. The semantic corpus does not fault-inject every malformed internal parser object. These tests also do not establish hard execution-time guarantees, exhaustive syntax rejection, arbitrary-size application support, or every PostgreSQL default/value rule.

## Reproducing failures

Run `npm run test:dbml` to build and run every DBML semantic suite, or `npm run check` for the full contributor gate. Test names contain their fixed hexadecimal seed and case index. For example:

```sh
npm run build
node --test --test-name-pattern='seed=5eed1234 case=3' dist/tests/dbml-generated.test.js
```

When a generated test fails, retain its seed and full input, then reduce it to a committed regression input when practical. Keep a handwritten expected result or rejection; do not update the oracle from adapter output. The current reduced failures and their origins are recorded in the [regression README](../tests/fixtures/regressions/README.md).

## Pending end-to-end proof

No emitter exists yet. Normalization tests therefore cannot establish TypeORM, NestJS, PostgreSQL execution, Aurora deployment, or Data API compatibility. The [M3 acceptance gates](implementation-plan.md#m3--typeorm-emission-and-postgresql-proof) must:

1. Compile generated entities/registry in a fresh strict consumer without `skipLibCheck` and execute under the declared module format.
2. Inspect TypeORM metadata against handwritten facts for these fixtures, including composite nullable keys, cycles, cross-schema names, multiple references, defaults and explicit junctions. Do not infer eager loading or persistence cascades.
3. Use isolated disposable PostgreSQL databases to compare normalized source catalog facts and generated catalog facts, with explicit exclusions for externally managed features. Only controlled test setup executes SQL; generation stays memory-only.
4. Exercise a separate minimal NestJS consumer and actual persistence for the M5 integration claim. Aurora/native-engine deployment and Data API transport/value behavior require their own isolated infrastructure and evidence.

A feature row is evidence at its stated layer, not a formal milestone acceptance or publication gate.
