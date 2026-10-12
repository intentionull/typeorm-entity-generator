# Contributing

## Scope

Build a deterministic TypeORM entity generator with a command-line interface and a typed library API. Keep parser evaluation, implemented features, and planned features clearly separated in documentation.

Follow the [implementation plan](docs/implementation-plan.md) for milestone order and acceptance criteria. The [fixture corpus guide](tests/fixtures/README.md) documents parser checks and provenance. Normalization, naming, and bounded in-memory PostgreSQL emission are implemented. Read the [emission profile](docs/postgres-emission.md) before extending generation; the CLI, public API and safe writer remain pending. See the [toolchain guide](docs/toolchain.md) for commands and license boundaries.

## Continuous integration

The [CI workflow](.github/workflows/ci.yml) checks every push and pull request, including fork pull requests, on GitHub-hosted Ubuntu runners with Node 24 and 26. It can also be dispatched manually. Both lanes run independently, and superseded runs are canceled. Job names are `Checks (Node 24)` and `Checks (Node 26)`; use these names for branch protection once the workflow is available remotely.

Reproduce each lane with the selected Node major active:

```sh
node --version
npm --version
npm ci --engine-strict --ignore-scripts --no-audit --no-fund
npm run check
```

Keep pull-request checks read-only. The workflow uses full commit pins for external actions, does not persist checkout credentials, and disables automatic dependency caching. It needs no npm publishing or cloud secrets and has no publishing or deployment steps. When updating an action pin, verify the release and full commit in the official action repository; keep the adjacent version comment accurate.

Both jobs check formatting, lint, strict types, documentation/vocabulary, license metadata, fixtures, normalization, naming, strict generated consumers and independent TypeORM metadata. Each also runs `npm run test:catalog` against a pinned disposable PostgreSQL service. Catalog tests execute only controlled test SQL and create/drop uniquely named test databases; the conversion pipeline never connects or executes SQL. `npm run check` includes a clean build; only its static checks are read-only. Use `npm run format` and review the result. Workflow changes can be checked locally with `actionlint .github/workflows/ci.yml`; this optional tool is not a package dependency.

## Documentation checks

Run `npm run check:docs` for the dependency-free, read-only repository scan, or `npm run test:docs` for its isolated regression tests. Findings include `path:line:column` and a rule code; fix the authored source rather than disabling the gate. The [check guide](docs/documentation-check.md) records the supported Markdown subset and exclusions. Keep required legal notices intact. Pinned upstream source is scanned for vocabulary but never rewritten; resolve any finding through maintainer review without silently changing attribution or source hashes. Review new wording and executable examples manually too: static checks cannot establish accuracy.

## Vocabulary

- Use domain-focused names: schema, table, column, key, index, relation, dialect, parser, adapter, emitter, diagnostic, and writer.
- Keep references to code-writing tools, their vendors, their product names, and authorship provenance out of identifiers, code, comments, examples, fixtures, documentation, package metadata, and generated files.
- Do not add authorship banners, promotional claims, or tool credits to generated output.
- Do not automatically copy source notes or comments into generated files. Any future comment-export feature must apply the same vocabulary policy and report excluded text.
- Review every authored repository file and generated fixture for vocabulary compliance before declaring a change complete. Review the packed npm contents before a release. Third-party copyright and license notices must remain intact.

## Behavior

- Never execute SQL or application source code to interpret an input file.
- Do not load executable configuration, third-party templates, or database credentials during ordinary file generation.
- Require an explicit database dialect when types or defaults depend on it.
- Preserve physical database names separately from TypeScript names.
- Reject ambiguous relationships, unknown types, unsupported schema-changing statements, and output name collisions rather than guessing.
- Keep unsupported details in structured diagnostics. Never report a lossy result as a faithful conversion.
- Database inspection must use read-only access and must not synchronize schemas or run migrations.
- Generate a complete file plan before writing. Do not overwrite unrelated files or hand-edited generated files.

## Development

- Use Node.js 24 LTS for development (minimum `24.11.0`). With nvm, run `nvm install` and `nvm use` from the repository root; `.nvmrc` selects the Node 24 line. Verify runtime changes on Node 24 and Node 26. Newer majors require their own checks before they are advertised as supported.
- Write a failing behavior test before changing implemented behavior. Test observable schema semantics, diagnostics, and output safety rather than private helper structure.
- Use independent schema fixtures, compilation checks, and database metadata comparisons. Snapshots alone are insufficient.
- Use `npm run test:postgres` for compiled normalization tests. Read the [PostgreSQL support table](docs/postgres-normalization.md) before extending the adapter; grammar acceptance is not supported semantics.
- Use `npm run test:dbml` for direct DBML normalization tests. Read the [DBML support table](docs/dbml-normalization.md); preserve exact numeric defaults, reference direction, and explicit uniqueness without SQL export or invented physical constraints.
- Use `npm run test:names` for compiled naming/override tests. Read the [naming rules](docs/naming.md) before changing conversion or collision behavior; keep generated mappings separate from physical schema facts.
- Use `npm run test:emission` for file-plan, strict ESM consumer and metadata tests. Run `npm run test:catalog` only against disposable local PostgreSQL, following the [integration instructions](docs/postgres-emission.md#catalog-tests). Neither command establishes persistence or cloud compatibility.
- Keep ordering, file names, and output bytes deterministic. Do not embed timestamps or machine-specific paths.
- Keep changes focused; do not add a new input adapter until its supported subset and failure behavior are tested.
- Use the current supported TypeORM APIs. Do not claim compatibility with a version that has not been checked.
- Run the narrowest relevant checks and inspect the final diff.
- For a new adapter, database profile, or output integration, follow the plan's extension checklist: declare the supported subset, add independent success/failure fixtures, reuse the shared pipeline, and update support evidence and documentation in the same change.
- Keep standard contributor checks credential-free. Cloud integration checks need separate protected infrastructure; an unavailable database or skipped cloud check is not a passing compatibility result.

## Distribution

- Keep the project's license MIT. Preserve dependency license obligations.
- The intended npm package is public. A proposed package name is not proof that its namespace is owned or available.
- Keep secrets, input dumps, connection strings, and customer schema information out of the repository and package tarball.
- Commits, pushes, publishing, releases, deployments, and service restarts require an explicit request in the current conversation. Repository documentation does not authorize these actions.

## Review and maintenance

- Submit changes through a pull request targeting `main`. Use the pull request template to describe scope, compatibility, validation results, and known limitations.
- [CODEOWNERS](.github/CODEOWNERS) assigns all paths, including repository controls, to `@intentionull`. Default-branch rules require one approval with code-owner review, resolved review threads, and up-to-date passing Node 24/26 checks. Stale approvals are dismissed after new commits.
- Merges use squash commits and linear history. Force pushes and deletion of `main` are blocked. The repository owner has an explicit bypass for exceptional maintenance; it is not the normal contributor workflow. GitHub does not allow self-approval, so an owner-authored pull request needs another eligible code owner or an explicit owner bypass.
- [Dependabot](.github/dependabot.yml) checks npm dependencies and pinned GitHub Actions weekly. Review each update against schema regressions and dependency license metadata. Preserve exact dependency versions and full-commit action pins. Major changes require explicit compatibility review; no dependency updates are automatically merged.
- Follow the [security policy](SECURITY.md) for private vulnerability reports. Do not include sensitive schema data or exploit details in public issues or pull requests.
