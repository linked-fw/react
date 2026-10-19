---
summary: >
  `@_linked/react` works with a second copy of itself or of `@_linked/core` in one runtime. Its 10
  cross-package `instanceof Shape` / `ShapeSet` / `QueryBuilder` checks use core's
  `isLinkedInstance` (core 2.36.2), and the shape-to-components registry lives in `sharedState`.
  Closes backlog 001.
packages: [react]
---

# Class checks and state across copies

Follows the convention in linked-fw/cli
[shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md)
(cli report [020](https://github.com/linked-fw/cli/blob/main/docs/reports/020-shared-state-and-error-brands.md),
the record of the cross-repo work) and uses what core backlog 057 added in `@_linked/core` 2.36.2
(`isLinkedInstance`, `brandLinkedClass`, with `Shape`, `ShapeSet` and `SelectBuilder`/`QueryBuilder` branded).
Closes backlog 001, which this report replaces. Released in `@_linked/react` 2.0.2.

## Problem

A module can be evaluated twice in one runtime: under `linked start` once by Vite's SSR module
runner and once by Node, or in a browser when two bundles each carry a copy. Each copy of core has
its own `Shape`, `ShapeSet` and `QueryBuilder` classes, and each copy of this package had its own
module-level registry. Measured before the change with the new test (below), using a second copy
of the modules:

- `linkedComponent(queryFromOtherCopy, …)` threw `Unknown data query type. Expected a QueryBuilder…`.
- A `ShapeSet` from the other copy passed as `of` to a `linkedSetComponent` was rejected.
- A `Shape` from the other copy was treated as result data: `ownPropsOf` forwarded its internal
  fields as props.
- Components registered through one copy were not in the other copy's registry (write-only inside
  the package today, so latent).

## What changed

| File | Change |
|---|---|
| `src/package.ts` | `shapeToComponents` moved into `sharedState('@_linked/react', 'componentRegistry', () => ({shapeToComponents: new Map()}))`. The container object is shared; `registerComponent` mutates its map. |
| `src/utils/LinkedComponent.ts` | 6 checks: `instanceof QueryBuilder` (3: set-component prop mapping, `processQuery` direct and keyed form), `instanceof ShapeSet` (2: `getLinkedSetComponentProps` validation and source selection), `instanceof Shape` (1: `getSourceFromInputProps`) now `isLinkedInstance(value, Cls)`. |
| `src/hooks/of.ts` | 4 checks: `subjectIdOf` (Shape), `subjectIdsOf` (ShapeSet), `isCompleteQResult` and `ownPropsOf` (Shape) now `isLinkedInstance`. |
| `package.json` | `@_linked/core` peer and dev range raised from `^2.27.0` to `^2.36.2` (first release exporting `isLinkedInstance` and branding the classes). |

The backlog counted 9 sites; there are 10 (`of.ts` has 4 `instanceof` checks: 3 on `Shape`, 1 on
`ShapeSet`). All are converted; `src/` has no `instanceof` on a core class left.

### Decisions

- **`isLinkedInstance` from `@_linked/core/utils/linkedError`**, not a local brand check. The
  brand is `Symbol.for('@_linked/core:<Class>')` on the class prototype, looked up along the value's
  prototype chain, so a user subclass of `Shape` from either copy matches. It falls back to
  `instanceof` for unbranded classes, so behaviour with one copy is unchanged.
- **Registry key name `componentRegistry`**: names what the state is; the convention requires
  only uniqueness within the package. The map is keyed by shape class, so each copy's classes are
  separate keys in the shared map.
- **A Shape from another copy is re-wrapped by `getSourceFromInputProps`.** It is now recognised
  as a Shape, but its `nodeShape` is the other copy's object, so the existing "different shape"
  branch creates `new shapeClass(input.id)` in the component's own copy. Same node, own class; no
  change needed.

## Tests

`src/tests/across-copies.test.tsx` (new, 5 tests). `jest.isolateModulesAsync` loads a second copy
of `../package.js`, the fixtures and `@_linked/core/collections/ShapeSet` with its own module
registry, so copy B has its own `@_linked/react` and its own `@_linked/core`.

- The second copy is a separate module (different `linkedComponent`, `Person`, `ShapeSet`).
- Components registered through either copy are in the one registry on
  `globalThis[Symbol.for('@_linked/react:componentRegistry')]`.
- A query built by copy B is accepted by copy A's `linkedComponent` and `linkedSetComponent`
  (keyed form).
- A `Shape` from copy B is a subject for `subjectIdOf`, is not a complete QResult, yields no own
  props, and `getSourceFromInputProps` gives a copy-A instance of the same node.
- A `ShapeSet` from copy B gives its ids to `subjectIdsOf` and renders as `of` of a copy-A
  `linkedSetComponent`.

The three class-check tests failed against core 2.36.1 with the old checks and pass now. Full
suite: 6 suites, 74 tests pass; `npm run typecheck` clean; `npx linked build` succeeds.

Loading the second copy prints core's warning that several copies of its shape registry are
loaded; that is the scenario under test.

## Known limitations and follow-ups

- Two Reacts cannot share anything; the convention treats that as a resolution bug (the CLI
  dedupes React). This package has no module-level React contexts, so nothing else to share.
- linked-fw/cli `docs/architecture/shared-state-and-error-brands.md` still lists react as
  "react backlog 001" in its status table; update it there when that table is next refreshed.

## PRs

- [linked-fw/react#89](https://github.com/linked-fw/react/pull/89): backlog 001, the state and class checks a second copy does not see (removed by #90).
- [linked-fw/react#90](https://github.com/linked-fw/react/pull/90): the change described here.
- [linked-fw/react#91](https://github.com/linked-fw/react/pull/91): release of 2.0.2.
