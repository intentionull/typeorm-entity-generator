# Security policy

## Supported versions

This project is in development and has no published npm release. Security fixes
currently target the latest commit on `main`; older development commits do not
have separate maintenance branches. This policy does not promise a stable API or
production readiness. A release-specific support policy must be documented before
the first public package release.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/intentionull/typeorm-entity-generator/security/advisories/new)
for suspected vulnerabilities. Do not disclose exploit details in public issues
or pull requests. Ordinary bugs without a security impact can use public issues.

Include, when available:

- The affected commit or package version and Node.js version.
- A minimal reproduction using a synthetic schema, not a production database dump.
- Expected and observed behavior, security impact, and any suggested mitigation.
- Relevant dependency versions and platform details.

Do not send credentials, access tokens, connection strings, personal data, or
private schemas. If a secret was exposed, revoke or rotate it before reporting.
The maintainer will review reports and coordinate fixes and disclosure; there is
no guaranteed response or remediation deadline.

## Security boundaries

Schema inputs and generated file paths must be treated as untrusted data. The
implemented PostgreSQL normalizer parses a bounded SQL subset without executing
SQL or opening database connections. Limits and unsupported semantics are
documented in [PostgreSQL normalization](docs/postgres-normalization.md).

The direct DBML normalizer also uses bounded input and returns structured errors
without exporting SQL or executing source. Its limits and unsupported physical
features are documented in [DBML normalization](docs/dbml-normalization.md).

Entity emission, filesystem output, the public library API, and the CLI are not
implemented yet. Their planned safeguards are not current security guarantees.
See the [project status](README.md) and [implementation plan](docs/implementation-plan.md)
for implemented and pending capabilities.

## Dependency changes

Dependabot proposes npm and GitHub Actions updates for maintainer review. Updates
are not automatically merged. Each change must retain locked dependencies,
full-commit action pins, license review, and passing Node 24/26 contributor checks.
