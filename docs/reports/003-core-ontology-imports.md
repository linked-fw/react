---
date: 2026-10-24
summary: >
  The test fixtures import `xsd` from the vocabulary package (`@_linked/xsd/ontologies/xsd`,
  namespace import) instead of core's internal `@_linked/core/ontologies/xsd`. `@_linked/xsd`
  ^1.4.1 added as a dev dependency. Published code unchanged. Patch.
---

# 003 — xsd from the vocabulary package in the test fixtures

## Why

`@_linked/core/ontologies/xsd` is core's internal module. The `xsd` terms are published by the
vocabulary package `@_linked/xsd` as a generated accessor module.

## What changed

- `src/tests/fixtures.ts`: `import {xsd} from '@_linked/core/ontologies/xsd'` →
  `import * as xsd from '@_linked/xsd/ontologies/xsd'`. The terms it uses exist in the generated
  module; they stay accessor references.
- `package.json`: `@_linked/xsd` ^1.4.1 in `devDependencies`, since only the tests use it. It
  depends only on `@_linked/core`, so it adds no cycle. Lockfile refreshed: `@_linked/xsd` needs
  `@_linked/core` ^2.41.0, so npm moved the locked dev copy of core from 2.39.3 to 2.42.1 (within
  the declared ^2.39.3) and the tests now run against it; `npm ls` shows one
  `@_linked/core@2.42.1`, deduped under `@_linked/xsd@1.4.1`.
- `.changeset/core-ontology-imports.md`: patch.
- A grep of `src`, tests and scripts for `@_linked/core/ontologies/(xsd|rdf|rdfs|owl)`, static
  or dynamic, finds nothing else.

## Gate

- `npx linked build`: "✔ Build successful". The repo's CLI (1.51.1) has no ontology-module step;
  `npm exec --package=@_linked/cli@1.57.1 -- linked build` reports "✔ Checking ontology modules".
- `npm test`: "Test Suites: 6 passed, 6 total", "Tests: 74 passed, 74 total".
- `npm run typecheck` (`tsc -p tsconfig-test.json --noEmit`): exit 0, no output.

## PR

### Summary

The test fixtures take their `xsd` datatypes from the `@_linked/xsd` vocabulary package instead
of core's internal ontology module.

### Changes

- `src/tests/fixtures.ts`: `import * as xsd from '@_linked/xsd/ontologies/xsd'`.
- `@_linked/xsd` ^1.4.1 as a dev dependency (tests only); lockfile refreshed, which moves the
  locked dev `@_linked/core` from 2.39.3 to 2.42.1 (`@_linked/xsd` needs ^2.41.0).
- Patch changeset.

### Verification

- `npx linked build`: "✔ Build successful"; with `@_linked/cli@1.57.1`: "✔ Checking ontology
  modules".
- `npm test`: "Test Suites: 6 passed, 6 total", "Tests: 74 passed, 74 total".
- `npm run typecheck`: exit 0.

### Deviations

None.

### Follow-ups

- The peer range `@_linked/core` ^2.36.2 is wider than the core the tests now run against
  (2.42.1); the published code is unchanged, so the range stays.
