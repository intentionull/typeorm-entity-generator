# Entity and column naming

The internal `resolveNames(document, options?)` function takes an already normalized [schema document](../src/schema/model.ts). It resolves entity class names, scalar column property names, and entity file basenames. It is synchronous and performs no filesystem access, database access, prompts, or SQL execution. There is no public package export or CLI for it yet.

The [typed options and result](../src/resolve/model.ts) are separate from physical schema facts. Success returns `ok: true`, an independent copy of the unchanged schema, ordered entity/column mappings, and an empty diagnostics array. Failure returns `ok: false` and diagnostics, without a partial mapping. Neither the input document nor options are modified. Resolve only validated internal schema documents; this function is not a validator for arbitrary schema objects.

## Default conversion

| Physical name | Entity class | Entity basename | Scalar property |
| --- | --- | --- | --- |
| `accounts` | `Accounts` | `accounts.entity.ts` | `accounts` |
| `API Accounts` | `ApiAccounts` | `api-accounts.entity.ts` | `apiAccounts` |
| `HTTPStatus` | `HttpStatus` | `http-status.entity.ts` | `httpStatus` |
| `created_at` | `CreatedAt` | `created-at.entity.ts` | `createdAt` |

These are examples of the same conversion rule, not instructions to generate an entity for every column:

1. Separate acronym-to-word boundaries and lowercase/digit-to-uppercase boundaries.
2. Split at ASCII punctuation, underscores, and spaces; lowercase the resulting words.
3. Join capitalized words for classes, or keep the first word lowercase for properties.
4. Derive the default basename from the **chosen class name** using lowercase hyphenated words plus `.entity.ts`. A class override therefore changes the default basename too.

No singularization, transliteration, schema-prefix inference, numeric collision suffixes, or relationship inference occurs. Default conversion requires printable ASCII physical names. Non-ASCII/control names, leading-digit results, empty results, and reserved generated identifiers require explicit overrides. Physical identifiers remain unchanged, including quoted case and punctuation.

## Declarative overrides

Use exact physical schema/table selectors, not generated names or dotted-name strings. Columns are selected by their exact physical names. Selectors are case sensitive; a dot inside a schema/table name is literal. Arrays avoid object-key ambiguity for names such as `__proto__`.

This example resolves physical `public.accounts` to class `AccountRecord` and file `account-records.entity.ts`; its scalar `parent_id` property becomes `parentKey`:

```json
{
  "tables": [
    {
      "table": { "schema": "public", "name": "accounts" },
      "className": "AccountRecord",
      "fileName": "account-records.entity.ts",
      "columns": [
        { "column": "parent_id", "propertyName": "parentKey" }
      ]
    }
  ]
}
```

Physical selectors are required. Generated name overrides are optional except `propertyName` in a selected column entry. Omitted names use the defaults. Empty options and empty arrays are valid. Unknown fields, malformed values, unknown targets, and duplicate targets fail rather than being ignored. Overrides must be plain declarative objects; functions and class instances are not options. There are no transformation hooks or schema-semantic overrides here.

## Validation and collisions

- Generated identifiers are ASCII, start with a letter, `_`, or `$`, and contain only letters, digits, `_`, or `$`. Maximum length is 128 characters. A deliberately conservative [reserved-name set](../src/resolve/names.ts) excludes language keywords/contextual names and `constructor`, `prototype`, and `__proto__`; it is not a full compiler or emitter check.
- Basenames are at most 200 ASCII characters, start with a letter or digit, and otherwise contain only letters, digits, `.`, `_`, and `-`, with the exact `.entity.ts` suffix. No paths, traversal (`..`), drive prefixes, or Windows device stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) are accepted. This is lexical validation, not an implementation of a safe writer.
- Class names must be unique across the document. Basenames must also be unique across the document after ASCII case folding, including when classes differ. Scalar property names must be unique within their table; reuse in another table is valid.
- Tables with the same generated name in different schemas still collide. Choose explicit class/basename overrides instead of silently adding schema prefixes. A distinct filename alone cannot repair a class collision.
- Successful mappings follow source table and column order, regardless of override order. Identical inputs/options produce identical results. Option-validation diagnostics follow option order; generated-name diagnostics follow schema order.

## Diagnostics and tests

| Code | Meaning |
| --- | --- |
| `NAME_OPTIONS` | Malformed declarative options or unknown fields |
| `NAME_OVERRIDE` | Unknown or duplicate physical override target |
| `NAME_INVALID` | Invalid/reserved generated identifier or nonportable basename |
| `NAME_COLLISION` | Duplicate class, case-folded basename, or table-local property |

Diagnostics carry an error severity, actionable message, and a copied source location. Known table targets include the physical qualified object name; column naming failures use the column location. Unknown table targets and root option-shape errors use offset 0, line 1, column 1; unknown column targets use the owning table location. Option/target failures are returned before resolving generated names.

Run `npm run test:names` for the [compiled naming tests](../tests/names.test.ts), or `npm run check` for the full contributor gate. Tests cover defaults, quoted/camel/acronym names, overrides, collisions, unsafe identifiers/basenames, malformed options, source locations, frozen inputs, deep-copy isolation, deterministic order, and unchanged enum/default/key/index/foreign-key facts.

## Boundaries

Enum symbols, relation properties, scalar/relation property collisions, emitter import/registry symbol conflicts, and final generated-project compilation belong to the [emission profile](postgres-emission.md). This naming layer neither creates those names nor claims they are checked. It does not write files or make regeneration safe. The [direct DBML adapter](dbml-normalization.md) supplies the same physical contract. The public library API, CLI, safe writer and release packaging remain in the [implementation plan](implementation-plan.md).
