---
summary: Active plan — automatic rerendering after mutations (reactivity) for @_linked/react via a query store with dependency-matching invalidation, with the HOCs rebuilt on a public hook. Route 2 from docs/002-reactivity-and-hooks-routes.md, delivered in standalone phases.
status: Ideation
packages: [react, core]
source: docs/002-reactivity-and-hooks-routes.md
---

# Reactivity: query store, invalidation, and hooks for `@_linked/react`

## Context

Ideation source: [docs/002-reactivity-and-hooks-routes.md](../002-reactivity-and-hooks-routes.md) (core/react contracts, current-implementation gaps, four routes). The user accepted **Route 2** — a query store with automatic, dependency-matched invalidation, HOCs rebuilt on a hook — delivered in phases that each stand on their own:

1. QueryStore + internal hook, HOCs rebuilt on it at behavior parity, known rough edges fixed.
2. Core: `subscribeQueryDispatch(listener)` (small additive release), then react: mutation observation + two-track dependency matcher + `invalidate()`.
3. Public hooks, query-context reactivity, docs.
4. Optional opt-in optimistic patch layer.
5. Later: Suspense, SSR hydration, server push, devtools.

Core may be changed freely where it makes the react side simpler (user decision, 2026-10-04). Phase 1 stays core-independent.

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
| 1 | Store scope: `globalThis` singleton vs React `Provider` vs both | decision B | accepted: 1C |
| 2 | Mutation observation: react-side dispatch wrapper vs a small core dispatch event | decision B | accepted: 2C |
| 3 | Query identity: two-track model (template + instance params), named templates, what the store holds | decision B | accepted: 3B |
| 4 | Hook API surface: names, return shape, `of` argument, options, set paging controller | decision B | open |
| 5 | HOC compatibility contract and refetch UX: stale-while-revalidate vs loader; `null` result handling; `_refresh` naming | decision B | open |
| 6 | Invalidation policy: default precision, per-query override, timing, batching, in-flight race | decision B | accepted: 6B |
| 7 | Query-context reactivity and preloaded (`of` QResult) children | decision B | open |
| 8 | Release: minor vs major; peer-dep floor; React Native entry parity | decision N | open |
| 9 | File layout, exports, and test strategy per phase | decision N | open |
| 10 | Optimistic patch layer design (phase 4) | research N | deferred to its phase |
| 11 | `exec(target)` bypasses the dispatch; manual `invalidate()` is the only cover | assumption N | accepted gap, document |
| 12 | Core event `subscribeQueryDispatch` | core change | accepted as part of 2C; sequenced before react phase 2 |

## Accepted decisions

### D1 — Store scope: global default, provider override later (1C)

The store is a class instance. The default instance lives on `globalThis` (same rule core uses for dispatch, routing and context in `runtime-instances.md`), and `resetQueryStore()` exists for tests. A `<LinkedStoreProvider store=…>` that overrides the store for a subtree is designed for but not shipped in phase 1; the hook reads `useContext(StoreContext) ?? globalStore`. Rejected: provider-only (mandatory wiring, breaks module-level HOCs rendered outside a provider, partial isolation anyway because core's state is global).

### D2 — Mutation observation: core `subscribeQueryDispatch` (2C)

Core's `queryDispatch.ts` gains `subscribeQueryDispatch(listener): () => void`. `setQueryDispatch(d)` stores an instrumented copy of `d` whose five methods notify listeners with `{kind: 'select'|'ask'|'create'|'update'|'delete', query, result: Promise}` after delegating. `resolveMutationDispatch` instruments an explicit `exec(target)` the same way, so targeted mutations are observed too. React subscribes once when the store is created; no wrapper, no install ordering, unaffected by repeated `setDefaultDataset`. Rejected: react-side lazy re-wrapping (missed-mutation window after a storage switch, fights `setDefaultDataset`, blind to `exec(target)`); making the core install idempotent (still a wrapper, still throws if react wraps before storage is configured).

### D3 — Query identity: two-track, template + instance (3B)

**Template** = the subject-less builder (what a `linkedComponent` is defined with, and what a graph database would be asked to tune). Identity = canonical `toJSON()` string, memoized per builder instance in a `WeakMap`; an optional `name` is metadata for the registry and devtools, not identity. The template owns the watch set, computed once: `projectionProps`, `filterProps` (where, scoped where, minus, sortBy), `shapes` (root + traversed + `as()` casts). Templates are registered at component definition; the watch set is computed lazily on first instance or eagerly by `prepareQueries()`, which also yields the list of all fireable queries for database tuning.

**Instance** = template applied to params `{subject | subjects, limit, offset, resolved context id, (later) variables}`. Key = template key + params string. Holds `status, data, error, seq, ids (every node id in the result tree + subjects), subscribers, inflight, staleWhileInflight`. Pending query contexts resolve into params and re-key on `subscribeQueryContext`. A closure-captured value inside a hook's `where` yields a new template per value (correct); core's future query variables become params instead. Templates with no instances are garbage-collected.

Indexes: `templatesByProp: Map<iri, Set<Template>>`, `templatesByShape: Map<iri, Set<Template>>`, `instancesById: Map<nodeId, Set<Instance>>`.

Change descriptor (also the format a server push would use): `{op, shape, props: Set<iri>, ids?: Set<nodeId>}`, `ids` undefined = unknown (`forAll`/`where` modes).

Rejected: one flat key per fully-applied query (no template level, no property index, nothing to hand to the database); name-keyed templates (silent merges/splits on name mistakes, unusable inline).

### D6 — Matching: index-driven with conservative fallbacks (6B)

- Known-id update/upsert: `instancesById[id]` for each id, keep instances whose template `projectionProps ∪ filterProps` intersects `change.props`.
- Any change whose props intersect a template's `filterProps`: all that template's instances (membership may change for nodes not in any result).
- Create: unbound instances of templates whose `shapes` relate to the created shape up or down the class hierarchy (`rdf:type` treated as a pseudo-property of shape scans).
- Delete with known ids: every instance mentioning an id, regardless of props, plus unbound instances over the shape. Delete-all/where: all instances of templates over the shape.
- Unknown ids (forAll/where update): all instances of templates whose props intersect.
- Timing: after the mutation promise resolves; coalesced per mutation in a microtask; an instance invalidated while fetching refetches once more when the inflight resolves; `seq` drops out-of-order responses.
- Levers: per template `{reactive: false}`; `invalidate(Shape | {id} | query)`; `refresh()` on an instance.
- Local optimistic patching stays in phase 4.

Rejected: shape-level only (editing one name refetches every list); patching now (pulls phase 4 into phase 2 for a latency-only gain).
