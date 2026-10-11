# Documentation and vocabulary check

The repository has a dependency-free, read-only check for common documentation mistakes and restricted terminology. It is a contributor gate, not a generator feature or a full Markdown parser.

## Commands

With Node 24.11.0 or newer active:

```sh
npm run check:docs
npm run test:docs
```

Neither command needs installed dependencies. For the combined gate, install the locked parser dependencies first:

```sh
npm ci --engine-strict --ignore-scripts --no-audit --no-fund
npm run check
```

`npm run check` scans the repository, then runs all validator and parser-fixture tests. `npm run test:fixtures` runs only the parser-fixture suite. Both Node 24/26 [CI lanes](../.github/workflows/ci.yml) run the documentation check and all tests after a clean install.

The script resolves its repository root from its own location, not the current working directory. Tests can supply a separate checkout root:

```sh
node scripts/check-docs.mjs /path/to/checkout
```

It reads files only: no network requests, prompts, configuration execution, formatting, or automatic fixes. Tests create disposable directories outside the checkout and verify that input bytes stay unchanged.

## Checks

| Rule | What fails |
| --- | --- |
| `DOC_LINK` | A local Markdown target is missing, unavailable, outside the checkout, or has invalid URL encoding |
| `DOC_LINK_SYNTAX` | An inline Markdown link has a malformed destination or closing delimiter |
| `DOC_REFERENCE` | An explicit reference-style link uses an undefined label |
| `DOC_FENCE` | A Markdown code fence has no matching closing marker |
| `VOCABULARY` | Restricted terminology appears in repository text, including comments, examples, identifiers, or package metadata |
| `VOCABULARY_PATH` | Restricted terminology appears in a repository file path |
| `CHECK_SYMLINK` | A scanned entry is a symbolic link; the scan does not follow it |
| `CHECK_IO` | The checkout root or a scanned directory/file cannot be read |

Findings use `path:line:column RULE message`, sorted by path and source position. Exit status is `1` on findings and `0` on success. File-path findings use line `1` and a column within the relative path.

### Markdown coverage

Use inline links/images, angle-bracket destinations for spaces, optional quoted titles, or reference links with single-line definitions. Single-level bracket labels, full/collapsed references, defined shortcut references, balanced parentheses in destinations, and escaped punctuation are supported. Reference labels are case-insensitive. Adjacent numeric citations without reference definitions are prose, not undefined links.

Local paths resolve relative to the containing document; paths beginning with `/` resolve from the checkout root. URL-encoded paths are decoded. Query strings and fragments are ignored when checking target existence; headings and fragment anchors are not validated. Existing directories are accepted as targets. External URL schemes, protocol-relative URLs, and fragment-only links are skipped without fetching anything.

Link-like text in fenced code, indented code, inline code spans, and HTML comments is ignored. Fences may use backticks or tildes, with up to three leading spaces; their closing marker must have the same character and at least the opening length. Vocabulary checks still inspect all of that original text.

Nested bracket labels, multiline reference definitions, blockquote/list-nested fences, HTML links, footnotes, and Markdown extensions are outside this small check's supported syntax. Use the supported forms in repository documentation and review rendered pages when changing more complex markup.

### Vocabulary coverage

The [contribution policy](../CONTRIBUTING.md#vocabulary) applies to all authored files and generated output. The checker enforces a finite list of restricted terms and phrases associated with code-writing tools, vendors, and authorship terminology. The rule definitions and negative-test inputs store numeric character sequences so they do not introduce prohibited wording into repository source.

Matching uses whole words and identifier segments, including common camel-case, Pascal-case, acronym, and underscore spellings. Harmless substrings in schema vocabulary, such as `email`, `paid`, and `maintainSchema`, do not fail. This is not a semantic classifier: unfamiliar product names, unusual spellings, or authorship claims without listed terms still need manual review. Keep generated examples and future npm tarball checks under the same policy.

## Exclusions and upstream material

The scan includes UTF-8 repository text, hidden configuration such as `.github`, and generated fixtures under `tests`. It excludes:

- Directories named `.git`, `node_modules`, `dist`, `coverage`, or `.nos-undo`.
- Secret files named `.env` or `.env.*`, and files ending in `.pem`, `.key`, `.p12`, or `.pfx`.
- Binary files containing zero bytes and files that are not valid UTF-8.
- Required legal notices named `LICENSE`, `LICENCE`, `COPYING`, `COPYRIGHT`, or `NOTICE`, optionally ending in `.md` or `.txt`, case-insensitively.

Legal exemptions protect required upstream wording; they are not permission to put unrelated code or documentation in notice files. Maintainers must review those notices and excluded release artifacts separately.

Pinned upstream source is not blanket-exempt from vocabulary checks. A finding reports its location without modifying source bytes; preserve attribution and hashes, then resolve the conflict through maintainer review. The [fixture tests](../tests/fixtures/README.md) separately verify upstream hashes. Do not rewrite original fixtures or strip required legal wording to obtain a passing check.

## Limits and maintenance

A passing check does not establish that documentation is true, examples execute, external links work, or a future npm package is ready. It does not replace build/type checks, consumer tests, security review, license review, or manual vocabulary review. The generator, public library API, and CLI remain unimplemented.

To change a rule, add an independently specified case to [the regression tests](../tests/documentation.test.mjs), show that it fails for the intended reason, then update [the check](../scripts/check-docs.mjs). Keep dependencies unnecessary, diagnostics actionable, and exclusions explicit. Never silently weaken a rule or modify third-party material to hide a finding.
