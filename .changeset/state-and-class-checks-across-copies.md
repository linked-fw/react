---
'@_linked/react': patch
---

Works when a second copy of `@_linked/react` or `@_linked/core` is loaded in the same runtime (Vite's SSR runner next to Node, or two bundles):

- `Shape`, `ShapeSet` and `QueryBuilder` values made by another copy of core are recognised. A query built by the other copy no longer throws "Unknown data query type" in `linkedComponent` / `linkedSetComponent`, a `ShapeSet` from it is accepted as `of`, and a `Shape` from it is treated as a subject rather than as plain result data. The checks use core's `isLinkedInstance`.
- The registry of components per shape that `linkedComponent` fills is kept with core's `sharedState` (key `Symbol.for('@_linked/react:componentRegistry')`), so every copy adds to one registry.

Requires `@_linked/core` 2.36.2 or later (peer range raised to `^2.36.2`).
