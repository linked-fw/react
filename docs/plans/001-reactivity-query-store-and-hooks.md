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
| 4 | Hook API surface: names, return shape, `of` argument, options, set paging controller | decision B | accepted: 4B |
| 5 | HOC compatibility contract and refetch UX: stale-while-revalidate vs loader; `null` result handling; `_refresh` naming | decision B | accepted: 5B |
| 6 | Invalidation policy: default precision, per-query override, timing, batching, in-flight race | decision B | accepted: 6B |
| 7 | Query-context reactivity and preloaded (`of` QResult) children | decision B | accepted: 7A (children: via parent, see D5) |
| 8 | Release: minor vs major; peer-dep floor; React Native entry parity | decision N | accepted: 8B variant (core minor, react 2.0) |
| 9 | Watch-set extraction lives in core (`queryDependencies`, `mutationEffects`) | decision B | accepted: 9B |
| 10 | File layout, exports, and test strategy per phase | decision N | accepted: 10B |
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

### D4 — Hooks: `useLinked` and `useLinkedSet`, mirroring the HOC pair (4B)

```ts
const {data, loading, refreshing, error, notFound, refresh, patch} =
  useLinked(query, of?, {enabled?, reactive?, name?});
const {data, loading, refreshing, error, refresh, patch, page} =
  useLinkedSet(query, of?, {enabled?, reactive?, name?});
// page: {next(), previous(), set(i), setLimit(n), index, limit}
```

`of` accepts `{id}`, a Shape, a QResult; for sets a ShapeSet or QResult[]. It is optional when the builder is already bound (`.for(id)` / `.for(getQueryContext(...))`). `loading` = no data yet; `refreshing` = data on screen, fetch in flight. The HOCs become thin wrappers over these hooks. Later extension (not in scope): `useLinked` accepting a `CountBuilder`/`AskBuilder` — a count is a template with an aggregation and no projection. Rejected: one overloaded hook (ambiguous cardinality, hairy types); core-verb hooks without `of` (drops the `of` ergonomics, needs a core accessor for the subject-less template).

### D5 — HOC contract: stale-while-revalidate, additive props, minor release (5B)

- Invalidation refetches and `_refresh()` keep current data on screen; `_refreshing: boolean` is injected next to `_refresh`.
- An `of` change renders cached data immediately when the store has that instance, otherwise the loader.
- A `null` single result keeps rendering the component with empty props (today's behaviour); a `notFoundElement` option, resolved like `loader`, can replace it.
- Cached instances are not revalidated on mount (invalidation is the freshness mechanism); a `refetchOnMount` option may come later.
- Preloaded children (`of` = QResult containing the child's labels) register no instance; they are reactive through the parent, whose template includes their fields (preload sub-selects) and whose ids include theirs. A QResult passed from a non-live source stays static; documented.
- Everything else (`source`, `linkedData`, `query` paging prop, `loader`, `errorElement`, `'rethrow'`, Native defaults) is unchanged.

Rejected: freezing today's behaviour (no way to show "updating", cached mounts still show a loader); a breaking rename to `refresh`/`data` (coordinated migration across six dependents for cosmetic gain; the underscore prefix avoids colliding with result keys).

### D7 — Query-context reactivity at store level (7A)

The store subscribes once to core's `subscribeQueryContext`. Instance params record the context *name* (not only the resolved id); on change the instance re-keys to the resolved id, fetches, and notifies subscribers; clearing the context returns those instances to pending (loader). `useQueryContext` clears on unmount only if the value it set is still current. Rejected: per-hook subscriptions (one per mounted component, store still needs the name); replacing the global context with a React provider (core's context is used by module-level and non-React code; two sources of truth).

### D8 — Releases: core minor, react per phase with a 2.0 major at the peer bump (8B variant)

- **Core**: one **minor** release carrying `subscribeQueryDispatch` (D2) and `queryDependencies` / `mutationEffects` (D9). Additive only; never a core major for this work. Merged and published before react phase 2 starts.
- **React phase 1** (store + hooks internal, HOCs rebuilt, rough edges fixed, `_refreshing`, `notFoundElement`): **1.7.0 minor**, peer `@_linked/core` unchanged.
- **React phase 2** (reactivity: observation, matcher, `invalidate()`): **2.0.0 major**. The major exists because the peer floor rises to the core minor above; it also legitimises any clean-ups we choose to bundle, though D5 keeps the existing prop contract (`_refresh`, `linkedData`, `query`) intact.
- **React phase 3** (public hooks, context reactivity, `prepareQueries`, docs): **2.1.0 minor**.
- Each phase ships its own changeset and PR; every new export is DOM-free and exported from both the root and `/native` entries.

Rejected: one release at the end (phases would not stand alone); a 2.0 that bundles the renames rejected in D5.

### D9 — Watch-set extraction lives in core (9B)

Core gains two small functions beside `lower()`, computed from the lowered IR so every DSL feature is covered once:

```ts
queryDependencies(query: SelectQuery | CountQuery | AskQuery):
  {projection: Set<iri>; filter: Set<iri>; shapes: Set<iri>}
mutationEffects(mutation: CreateQuery | UpdateQuery | DeleteQuery, result?: unknown):
  {op: 'create'|'update'|'upsert'|'delete'; shape: iri; props: Set<iri>; ids?: Set<string>}
```

`filter` covers where, scoped relation where, minus and sortBy inputs; `shapes` covers the root scan, traversed value shapes and `as()` casts; `props` for a delete is "all properties of the shape" and `ids` is undefined for `forAll`/`where` modes; the mutation `result` supplies created ids and `added`/`removed` ids. React's matcher consumes these directly. Rejected: react re-parsing DSL-JSON (a second implementation of the wire grammar that drifts); walking `FieldSet` entries and `WherePath` objects (semi-internal structures, duplicated traversal).

### D10 — Layout, exports, tests (10B)

- `src/store/` (no React import, extractable later): `QueryStore.ts`, `templates.ts`, `matcher.ts`, `changes.ts`, `keys.ts`.
- `src/hooks/`: `useLinked.ts`, `useLinkedSet.ts`, internal store subscription via `useSyncExternalStore`.
- `src/utils/LinkedComponent.ts` slimmed to HOC wrappers, types, loader/error/notFound resolution.
- Exports from both entries: `useLinked`, `useLinkedSet`, `invalidate`, `prepareQueries`, `getQueryStore`, `resetQueryStore`, plus a `withQuery(Comp, query)` helper so hook-only components stay preloadable.
- Tests: React-free `query-store.test.ts` (keys, templates, table-driven matching over Person/Team fixtures in a shared `fixtures.ts`), `reactivity.test.tsx` (team scenario end to end against the mock store), existing behaviour suite kept green as the compatibility gate; add a `typecheck` script to the quick gate. Core: unit tests for the dispatch event and the two helpers, plus golden cases in the existing suites.

Rejected: growing the single file; a separate store package before a second consumer exists.

## Ideation status

All blocking items have accepted decisions (1C 2C 3B 4B 5B 6B 7A 8B-variant 9B 10B). Non-blocking items 10 (optimistic patching) and 11 (`exec(target)`, now covered by D2's instrumentation of `resolveMutationDispatch`) carry into the plan as notes. Ready for plan mode on user confirmation.
