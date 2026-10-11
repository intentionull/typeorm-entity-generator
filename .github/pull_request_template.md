## Summary

Describe the change, the problem it solves, and any linked issue.

## Scope and compatibility

Describe changes to supported schema semantics, diagnostics, generated names, or
compatibility. Distinguish implemented behavior from planned features. Mark this
section not applicable for changes that do not affect behavior.

## Validation

List the commands run, runtime versions, results, and anything not checked with a
reason. Run `npm run check` locally; Node 24 and 26 CI must pass before merging.

- [ ] Added independent regression tests for changed behavior, or explained why none are needed.
- [ ] Updated relevant documentation and retained database/schema-focused terminology.
- [ ] Preserved fixture bytes, attribution, and third-party license notices where applicable.
- [ ] Kept secrets, credentials, private schemas, and dependency/build artifacts out of the change.

## Review notes

Call out limitations, unsupported cases, and areas needing maintainer attention.
Report security vulnerabilities privately through the repository's security policy,
not in this pull request.
