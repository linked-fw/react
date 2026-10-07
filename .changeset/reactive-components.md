---
"@_linked/react": major
---

Reactive components and hooks on top of `@_linked/core`'s live queries.

**Breaking:** the `@_linked/core` peer range is now `^2.25.0`, the first core release with live queries (`query.live()`, `subscribeQueryDispatch`, `queryDependencies`, `mutationEffects`). Nothing in the component API was removed or renamed.

- `linkedComponent` / `linkedSetComponent` are rebuilt on the core live-query store. After any mutation — local (`await Shape.update(...)`), reported by a dataset's change feed, or published with `publishChange()` — every mounted component whose query can have read the changed data refetches and rerenders; nothing else does. Data stays on screen during a refetch; `_refreshing` is injected next to `_refresh`; identical queries share one request; a subject that is already cached renders immediately.
- New `notFoundElement` option/prop (resolved like `loader`) for a single-subject query that answers `null`; new `name` and `reactive` options (`reactive: false` opts a component out of automatic refetching).
- New hooks `useLinkedQuery(query, of?, options?)` and `useLinkedSetQuery(query, of?, options?)`, and `withQuery(Component, query)` to make a hook-based component discoverable by `preloadFor` and the package registry. `invalidate`, `publishChange` and `getLiveQueryStore` are re-exported from core.
- Fixed: a `linkedSetComponent` defined before storage was configured never loaded; a new `ShapeSet`/array per parent render refetched every render; a fast `of` change could render an older response; a component bound to a pending query context did not update when the context landed; `useQueryContext` now clears on unmount (only if its value is still the current one).
