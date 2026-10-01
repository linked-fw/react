---
summary: Active plan — automatic rerendering after mutations (reactivity) for @_linked/react via a query store with dependency-matching invalidation, with the HOCs rebuilt on a public hook. Route 2 from docs/002-reactivity-and-hooks-routes.md, delivered in standalone phases.
status: Ideation
packages: [react]
source: docs/002-reactivity-and-hooks-routes.md
---

# Reactivity: query store, invalidation, and hooks for `@_linked/react`

## Context

Ideation source: [docs/002-reactivity-and-hooks-routes.md](../002-reactivity-and-hooks-routes.md) (core/react contracts, current-implementation gaps, four routes). The user accepted **Route 2** — a query store with automatic, dependency-matched invalidation, HOCs rebuilt on a hook — delivered in phases that each stand on their own:

1. QueryStore + internal hook, HOCs rebuilt on it at behavior parity, known rough edges fixed.
2. Mutation observation (dispatch wrapper) + dependency matcher + `invalidate()`.
3. Public hooks, query-context reactivity, docs.
4. Optional opt-in optimistic patch layer.
5. Later: Suspense, SSR hydration, core `subscribeQueryDispatch`, server push, devtools.

No `@_linked/core` changes are required; a small additive core event is a later nice-to-have.

## Architecture constraints (from `docs/architecture`)

- **react**: no architecture docs exist yet (`npx semantu-agents docs architecture` lists none).
- **core** `runtime-instances.md`: core must be one module instance per runtime; critical process-wide state (dispatch, routing, context) is `globalThis`-backed so an accidental double evaluation shares state. Any react-side singleton (the query store, the dispatch wrapper) must follow the same rule or it will fork under the same dev double-load that core already guards against. Only plain data crosses runtimes; never live `Shape` instances.
- **core** `ontologies.md`, `publishing.md`: not applicable to this scope.

## Test surfaces

| Package | Quick gate | Runtime | Full / slow | Source |
|---|---|---|---|---|
| react | `npm test` (jest, jsdom, mock `IDataset`; ignores the Fuseki suite) | ~8 s wall, 35 tests | `npm run test:integration` (needs Docker + Fuseki, uses core's uncompiled `test-helpers` via `../core`) | `package.json` scripts, `jest.config.cjs` |
| core | not impacted | | | |

Gap: no typecheck script in react (`core` has `npm run typecheck`); `npm run compile` is the closest gate. Record as a plan item.

Installed devDependency `@_linked/core@2.22.8` already exports `subscribeQueryContext`, `getQueryDispatch`, `setQueryDispatch`, `hasPendingContext`, `FieldSet`/`PropertyPath`, so the current peer floor `^2.22.8` holds.

## Open-item map

Blocking planning (B) or non-blocking (N).

| # | Item | Kind | Status |
|---|---|---|---|
| 1 | Store scope: `globalThis` singleton vs React `Provider` vs both | decision B | open |
| 2 | Mutation observation install: auto on first hook use vs explicit `enableReactivity()`; lazy re-wrap after `setDefaultDataset` | decision B | open |
| 3 | Query identity / cache key: canonical JSON memoized per builder; inline builders in hooks; pending-context keys | decision B | open |
| 4 | Hook API surface: names, return shape, `of` argument, options, set paging controller | decision B | open |
| 5 | HOC compatibility contract and refetch UX: stale-while-revalidate vs loader; `null` result handling; `_refresh` naming | decision B | open |
| 6 | Invalidation policy: default precision, per-query override, timing, batching, in-flight race | decision B | open |
| 7 | Query-context reactivity and preloaded (`of` QResult) children | decision B | open |
| 8 | Release: minor vs major; peer-dep floor; React Native entry parity | decision N | open |
| 9 | File layout, exports, and test strategy per phase | decision N | open |
| 10 | Optimistic patch layer design (phase 4) | research N | deferred to its phase |
| 11 | `exec(target)` bypasses the dispatch; manual `invalidate()` is the only cover | assumption N | accepted gap, document |
| 12 | Core event `subscribeQueryDispatch` to replace the wrapper | follow-up N | propose after descriptor format settles |

## Accepted decisions

_(filled in as explore batches are accepted)_
