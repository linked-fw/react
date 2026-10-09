---
"@_linked/react": major
---

Reactive components and hooks on top of `@_linked/core`'s live queries.

**Breaking:** the `@_linked/core` peer range is now `^2.27.0`, the first core release with live queries (`query.live()`, `subscribeQueryDispatch`, `queryDependencies`, `mutationEffects`). Nothing in the component API was removed or renamed.

- `linkedComponent` / `linkedSetComponent` are rebuilt on the core live-query store. After any mutation — local (`await Shape.update(...)`), reported by a dataset's change feed, or published with `publishChange()` — every mounted component whose query can have read the changed data refetches and rerenders; nothing else does. Data stays on screen during a refetch; `_refreshing` is injected next to `_refresh`; identical queries share one request; a subject that is already cached renders immediately.
- New `notFoundElement` option/prop (resolved like `loader`) for a single-subject query that answers `null`; new `name` and `reactive` options (`reactive: false` opts a component out of automatic refetching).
- New hooks `useLinkedQuery(query, of?, options?)` and `useLinkedSetQuery(query, of?, options?)` for components that need several queries, state-dependent queries, conditional fetching or inline counts. Hook-based components are not discoverable (no static `query`); use `linkedComponent` for anything that should be preloadable or listed with its data requirements. `invalidate`, `publishChange` and `getLiveQueryStore` are re-exported from core.
- Fixed: a `linkedSetComponent` defined before storage was configured never loaded; a new `ShapeSet`/array per parent render refetched every render; a fast `of` change could render an older response; a component bound to a pending query context did not update when the context landed; `useQueryContext` now clears on unmount (only if its value is still the current one).

Behaviour notes: `_refresh(patch)` now edits the shared cached result (visible to every component on the same query and subject until the next refetch); `reactive` and `name` apply to the query template; the set component's `query.setLimit()` returns to the first page; a `Shape` instance passed as `of` is now always fetched (it was mistaken for preloaded data); a component mounted before storage is configured loads once storage is set; an empty `of` set renders an empty list without fetching; `useQueryContext` no longer re-sets the context when a parent passes a new object with the same id. Hooks and components are StrictMode-safe.
