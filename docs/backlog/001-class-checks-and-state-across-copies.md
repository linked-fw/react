---
summary: >
  `@_linked/react` checks `instanceof QueryBuilder`, `ShapeSet` and `Shape` from `@_linked/core` in 9
  places, which a value from another copy of core fails, and keeps its shape-to-components registry
  per copy. Switch the checks to core's brand check once it has one (core backlog 057) and move
  the registry to `sharedState`.
packages: [react]
---

# 001 — Class checks and state across copies

A module can be evaluated twice in one runtime (Vite's SSR runner and Node under `linked start`, or two browser bundles). The convention ([shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md)) keeps caller-set module state on `globalThis` with `sharedState(pkg, name, init)` from `@_linked/core` 2.36.0, React contexts in that shared state, and brands error classes with `brandLinkedError` so consumers match them with `isLinkedError`. Each fix needs a test that loads a second copy of the module (`jest.isolateModulesAsync`, or a `?copy` query on the built file) and shows the state is shared.

Found by the survey for linked-fw/cli backlog 017. Paths under `src/`.

## Cross-package `instanceof`

| File | Check |
|---|---|
| `utils/LinkedComponent.ts:534,580,591` | `instanceof QueryBuilder` — a query built by another core copy is treated as plain data. |
| `utils/LinkedComponent.ts:615,628`, `hooks/of.ts:31` | `instanceof ShapeSet` |
| `utils/LinkedComponent.ts:656`, `hooks/of.ts:23,47,61` | `instanceof Shape` — a Shape from another copy is not recognised in the `of` prop. |

These are core classes, not errors, so `isLinkedError` does not apply. Core backlog
[057](https://github.com/linked-fw/core/blob/main/docs/backlog/057-module-state-a-second-copy-does-not-see.md)
proposes `isLinkedInstance(value, Cls)`; switch these when it exists.

## Must be shared

`package.ts:10` `shapeToComponents` Map, filled by `linkedComponent`. Components registered
through one copy are missing from the other. It is write-only inside this package today, so latent.
