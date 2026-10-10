# Development toolchain

Use Node 24.11.0 or newer; `.nvmrc` selects Node 24 for development. CI runs Node 24 and 26 on Ubuntu. Recheck the declared minimum patch whenever runtime requirements change. These lanes are development checks, not a cross-platform or database support claim.

## Reproducible setup

```sh
node --version
npm --version
npm ci --engine-strict --ignore-scripts --no-audit --no-fund
npm run check
```

Dependencies and direct tool versions are locked. Lifecycle scripts stay disabled; the parser uses its shipped WASM build and Biome uses its platform package. Tests use Node's built-in test runner. TypeScript tests are compiled before execution; there is no runtime source-transform loader.

| Component | Pinned version | Purpose | License metadata |
| --- | --- | --- | --- |
| TypeScript | 7.0.2 | CLI compiler and type checks | Apache-2.0 |
| Node types | 24.19.2 | Node 24 development API declarations | MIT |
| Biome | 2.5.15 | One formatter and focused lint configuration | MIT OR Apache-2.0 |
| PostgreSQL parser | 18.1.5 | Internal syntax adapter and fixtures | MIT |
| DBML parser | 10.3.1 | Parser fixtures; normalization still pending | Apache-2.0 |

The compiler uses strict NodeNext ESM resolution, explicit `.js` imports, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, declarations, and source maps. `skipLibCheck` is false. Source and TypeScript tests compile into `dist/`; failed compilation does not emit. The TypeScript CLI is used rather than its legacy compiler API.

Biome applies two-space indentation, single quotes, and 100-column formatting to supported JS/TS/JSON files. Lint focuses on correctness and suspicious constructs, with explicit `any` rejected. Build output, lockfile, and fixture files are excluded. Fixture exclusions preserve pinned upstream bytes; their hashes are separately checked. Markdown uses the separate [documentation check](documentation-check.md), not a claimed Markdown formatter.

## Commands

| Command | Current behavior |
| --- | --- |
| `npm run check` | Formatting, lint, no-emit type checks, documentation/vocabulary, license metadata, build, and all tests |
| `npm test` | Clean/build TypeScript, then run existing `.mjs` tests and compiled TypeScript tests |
| `npm run test:postgres` | Clean/build and run only PostgreSQL normalization tests |
| `npm run test:names` | Clean/build and run only entity/column naming and override tests |
| `npm run test:fixtures` | Parser fixture/hash tests without a build |
| `npm run test:docs` | Documentation checker regression tests without a build |
| `npm run test:tooling` | Cleanup and license-inventory regression tests without a build |
| `npm run build` | Remove checkout-local `dist`, then compile source/tests |
| `npm run clean` | Remove only checkout-local `dist`; do not follow an output-directory symlink |
| `npm run check:types` | Strict no-emit TypeScript check |
| `npm run check:format` | Read-only formatting check |
| `npm run format` | Apply formatting to supported authored files; review the result |
| `npm run lint` | Read-only focused lint check |
| `npm run check:docs` | Dependency-free read-only text/path and Markdown check |
| `npm run check:licenses` | Print sorted lockfile license metadata and fail on missing/unreviewed values |

`npm run check` writes build artifacts through `npm test`; only its static checks are read-only. Run tests from the repository root so fixture paths resolve. No integration/package test commands exist yet; their implementation remains in the [plan](implementation-plan.md).

## License and distribution boundary

Our code is [MIT](../LICENSE). Dependencies and copied fixtures retain their licenses. The initial lockfile inventory permits MIT, Apache-2.0, BSD-3-Clause, and the dual-license expression shown above. A changed or missing expression requires maintainer review; passing this check is not a full legal audit. Actual dependency notices, redistribution requirements, optional platform packages, and the eventual tarball still require review before publication. Preserved fixture notices live with the [fixture corpus](../tests/fixtures/README.md).

The manifest remains `private: true`. This toolchain does not make the package release-ready or establish TypeORM, NestJS, PostgreSQL server, or Aurora compatibility. CI has no publishing/deployment step or write credentials. Its [workflow](../.github/workflows/ci.yml) uses pinned actions, read-only repository permissions, no persisted checkout credentials, and no automatic package-manager cache.
