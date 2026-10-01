---
summary: Ideation — routes for automatic rerendering (reactivity) in @_linked/react after mutations, and whether to move to hooks. Analysis of core's DSL/response contracts, the current react implementation, four candidate routes with pros/cons, and a recommendation.
packages: [react, core]
---

# Reactivity and hooks for `@_linked/react` — routes and recommendation

Status: ideation (no code changes). Written against `@_linked/core` 2.24.1 and `@_linked/react` 1.6.2.

## 1. The problem

Two components, one subject:

```tsx
const TeamMembers = linkedComponent(
  Team.select((t) => t.members.name),
  ({members}) => <ul>{members.map((m) => <li key={m.id}>{m.name}</li>)}</ul>,
);

const TeamHeader = linkedComponent(
  Team.select((t) => [t.name, t.members.size()]),
  ({name, members}) => <h2>{name} ({members})</h2>,
);

// somewhere else
await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
```

Today nothing rerenders. Each wrapper instance owns a `useState` with its result, fetches once in a `useEffect`, and the only way to see new data is `_refresh()` or a parent rerender that changes `of`.

Goal: after the update resolves, every mounted component whose query *could* have changed rerenders with fresh data, with no network requests beyond the refetches that are actually needed, and without the application author wiring anything.

## 2. What core gives us (relevant contracts)

Everything below is public in `@_linked/core` and needs no core change.

### Selects

- `SelectBuilder` is immutable; every chain call returns a new instance. `Shape.select(fn)` returns one.
- `query.toJSON()` is canonical DSL-JSON: `{v, shape, fields, subject?, subjects?, one?, where?, sortBy?, minusEntries?, limit?, offset?}`. Fields are dotted label paths (`"members.name"`, `"pets.as(Dog).level"`), relation-keyed objects with nested `fields`/`where`/`limit`, or computed `{as, value}` S-expressions. `preloadFor(Component)` entries are merged into `fields` as sub-selects, so a parent query's JSON already covers its preloaded children.
- `query.fields()` returns a `FieldSet`; `fieldSet.paths()` returns `PropertyPath[]` whose `segments` are `PropertyShapeData` (with `id`, `label`, `path: PathExpr`, `valueShape`). That gives property IRIs and traversed shapes directly, no string parsing.
- `query.hasPendingContext()` and `subscribeQueryContext(listener)` exist. `QueryBuilder._run` returns `null` for an unresolved context with the comment "a reactive layer re-runs once it lands".
- Results: `ResultRow = {id, ...}`; nested traversals are nested `ResultRow`/`ResultRow[]`, so every node a result mentions carries its `id`. `.for(id)` queries unwrap to a single row or `null`.
- Counts (`.count()`, `.size()`) and asks travel the same dispatch; `CountBuilder.toJSON()` has `{op:'count', shape, subject?, where?}`.

### Mutations

- `Shape.update(data).for(id | ctx) | .forAll() | .where(fn)`, `Shape.upsert(data).for(id)`, `Shape.create(data)`, `Shape.delete(ids) | deleteAll() | deleteWhere(fn)`.
- `mutation.toJSON()`: `{op:'update'|'upsert', shape, mode:'for'|'forAll'|'where', targetId?, where?, data:{label: value}}`; `{op:'create', shape, data}`; `{op:'delete', shape, mode:'ids'|'all'|'where', ids?|where?}`. Set relations use `{"@add": [...], "@remove": [...]}`; nested node descriptions in `data` are nested creates.
- Results: `UpdateResult = {id, ...fields}` where a set field is `{updatedTo}` or `{added, removed}` (each a `ResultRow[]`), `CreateResult = ResultRow`, `DeleteResponse = {deleted: NodeReferenceValue[], count}`.
- Property label → IRI: `getPropertyShape(shape.shape, label)` from `@_linked/core/shapes/nodeShapeData`. Class relations: `getShapeClass(iri)`, `hasSuperClass(cls, parent)` from `@_linked/core/utils/ShapeClass`.

### Dispatch

- `LinkedStorage.setDefaultDataset(ds)` installs a global `QueryDispatch` via `setQueryDispatch({selectQuery, askQuery, createQuery, updateQuery, deleteQuery})`. `await builder` and `builder.exec()` go through `getQueryDispatch()`. The react wrapper already calls `getQueryDispatch().selectQuery(q)` directly.
- `getQueryDispatch()` / `setQueryDispatch()` are exported, so a package can wrap the dispatch. Two caveats: `setDefaultDataset()` re-installs the dispatch (a wrapper installed earlier is overwritten), and `builder.exec(target)` bypasses the dispatch entirely.

## 3. Current `@_linked/react` implementation — observations

`src/utils/LinkedComponent.ts` (one 1,000-line file) provides `linkedComponent` and `linkedSetComponent` as `forwardRef` HOC factories.

What works well and should be kept:

- `of={{id}} | shape | QResult` on the outside, query-result keys as props on the inside. This is the signature feature and it is what `preloadFor(Component)` relies on: the component carries a static `.query`.
- A `QResult` passed as `of` that already contains every selected label skips the fetch (`isValidQResult`). Preloaded children render synchronously.
- `loader` / `errorElement` resolution chain, `'rethrow'` sentinel, React Native entry.
- `_refresh()` to refetch and `_refresh(patch)` for a local optimistic patch.

Gaps and rough edges that a rewrite should fix regardless of route:

1. No shared cache, no request dedup. Two `TeamHeader of={team}` instances fetch twice; nothing is shared across components.
2. No mutation observation at all. The README's optimistic-UI example is the only path, and it is manual.
3. `linkedSetComponent` reads `LinkedStorage.isInitialised()` **at factory time** (outside render). A set component defined before storage setup never loads.
4. `linkedSetComponent`'s load effect depends on `props.of` by identity. A parent that builds a new `ShapeSet`/array per render refetches every render.
5. `linkedComponent`'s `loadData` guards on `loadingData` state and `console.warn`s on re-entry; `_refresh` is a `useCallback` over `queryResult`, and there is no sequence guard, so a fast `of` change can apply an out-of-order response.
6. Pending query context: the wrapper shows the loader but nothing triggers a rerender when the context lands (only a parent rerender does). `subscribeQueryContext` is unused. `useQueryContext` never clears on unmount despite its doc comment.
7. `typeof window !== 'undefined'` gate means SSR always emits the loader.
8. Single-result `null` (missing node) is mapped to `{}` so the component renders with undefined props; there is no "not found" signal.

None of these are blockers, but they say the internal data path should be rebuilt once, on one primitive, rather than patched twice.

## 4. Design dimensions

The reactivity question decomposes into four independent choices. Routes in §5 are combinations.

### A. How do we learn that data changed?

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| A1 Dispatch wrapper | `setQueryDispatch(observe(getQueryDispatch()))`; `create/update/deleteQuery` call-through and emit a change descriptor after the promise resolves | Zero core changes; catches every `await Shape.update(...)` in the app; also sees selects (for the cache) | Must re-wrap lazily because `setDefaultDataset()` overwrites it (cheap identity check on each hook mount); `exec(target)` is invisible |
| A2 Dataset decorator | `LinkedStorage.setDefaultDataset(reactive(store))` | Explicit, no ordering issue, works for `exec(target)` if the user passes the wrapped store | One more thing to remember, per pinned dataset too |
| A3 Core event | `subscribeQueryDispatch(listener)` in `queryDispatch.ts`, same shape as `subscribeQueryContext` | Cleanest; removes A1's fragility; ~30 lines; precedent exists | Touches core (small, additive) |
| A4 Explicit invalidation | `invalidate(Team)`, `invalidate({id})`, `invalidate(query)`; a `mutate()`-style helper | Predictable; works for mutations that happen outside the client (server jobs, websockets) | Not automatic; the user asked for automatic |

Recommendation: A1 now, A4 as escape hatch and as the entry point for server-pushed changes, propose A3 to core when the shape of the change descriptor is stable.

### B. Which live queries does a mutation affect? (dependency tracking)

This is the "tracking property paths and overlapping paths between shapes" the question describes. Two sources of truth are cheap and already in hand: the query's DSL-JSON/FieldSet (what it *reads*) and its last result (which *nodes* it mentions).

Per live query entry, compute once:

- `projectionProps`: property IRIs of every segment of every field path, including nested sub-selects, computed expression paths, aggregations (`size()`), and preload sub-selects. `selectAll()` expands to all property shapes of the shape. Complex `PathExpr`s (`seq`, `alt`, `inv`) contribute every `PathRef` inside them.
- `filterProps`: property IRIs used in `where`, scoped relation `where`, `minusEntries`, and `sortBy`.
- `rootShape` and `traversedShapes` (from `valueShape` of relation segments, plus `as(Shape)` casts), each expanded with super- and subclasses.
- `bound`: whether the query is subject-bound (`subject`/`subjects`) or scans the shape.

Per result, recompute (O(result size)):

- `ids`: every `id` in the result tree, plus the query's own `subject`/`subjects`.

Per mutation, compute once from `toJSON()` plus the result:

- `op`, `shape` (expanded with super/subclasses), `props` (keys of `data` resolved to IRIs; for `@add`/`@remove` the relation IRI; nested node descriptions add the nested shape's props; create adds `rdf:type` as a pseudo-property; delete adds *all* props of the shape plus unknown inbound edges), `ids` (`targetId`, `ids`, the created `id`, `added`/`removed` ids from the result) or **unknown** for `forAll`/`where`/`deleteWhere`.

Match rule (invalidate when any holds):

1. `filterProps ∩ mutation.props ≠ ∅` — a filter/sort/minus input changed; membership may change for nodes not in the result, so ignore ids.
2. `projectionProps ∩ mutation.props ≠ ∅` and (`mutation.ids` unknown, or `!bound`, or `ids ∩ mutation.ids ≠ ∅`).
3. `op` is `create` or `delete` and the mutation shape overlaps `rootShape`/`traversedShapes` and (`!bound` or, for delete, `ids ∩ mutation.ids ≠ ∅`).

Worked example (the team): `Team.update({members:{add:[P]}}).for(T)` → props `{members}`, ids `{T, P}`. `TeamHeader` projects `{name, members}` and its ids contain `T` → rule 2 → refetch. `TeamMembers` projects `{members, Person.name}`, ids contain `T` → refetch. A `PersonCard of={otherPerson}` projecting `{name}` has no prop overlap → untouched. `Person.update({name}).for(P)` later: `TeamMembers` has `name` in projection and `P` in ids → refetch; `TeamHeader` projects `Team.name`, a different IRI unless the ontology reuses it, and `P ∉ ids`... but if both shapes share one `name` IRI (common with `schema:name`), `P ∈ TeamMembers.ids` only, so `TeamHeader` stays untouched. Correct in both cases.

Granularity options, in increasing precision: shape-level (B1), property-level (B2), property + id level (B3, the rule above). Over-invalidation costs one extra fetch; under-invalidation is a bug, so every "cannot tell" case falls back to the coarser level. Per-query override: `{invalidate: 'auto' | 'shape' | 'manual'}`.

Costs: entries number in the tens to low hundreds; matching is a few `Set` intersections per entry per mutation. An index `Map<propIRI, Set<entry>>` makes it O(touched props) if ever needed.

### C. Where do results live and how do components subscribe?

| Option | Description | Pros | Cons |
|---|---|---|---|
| C1 Per-instance state + bus | Keep `useState` per wrapper; each instance registers its deps on mount and refetches on a matching event | Smallest diff; keeps HOC code | No dedup, no sharing, no stale-while-revalidate; every instance fetches; hard to grow into Suspense/SSR |
| C2 Query store | Module-level store keyed by canonical query key (`JSON.stringify(toJSON())`, memoized per builder instance in a `WeakMap`); entries hold `{query, deps, status, data, error, promise, subscribers, updatedAt}`; components subscribe with `useSyncExternalStore`; GC after last unsubscribe with a grace period; structural sharing on refetch so deep-equal results keep their reference and skip rerenders | Dedup, sharing, invalidation in one place, back-navigation cache, foundation for Suspense/SSR/devtools; well-understood pattern (React Query, SWR, Relay) | ~500 lines of new infrastructure; must get in-flight/stale races right (sequence numbers, refetch-once-more if invalidated mid-flight) |
| C3 Local replica / normalized graph | Run a client-side `@_linked/rdf-mem-store` as a write-through replica; queries execute locally where possible, mutations patch the graph | Every projection, including counts and filters, updates locally; offline-capable; the "option 1" dream | Partial-data semantics (OPTIONAL missing vs not-yet-loaded) need a core concept; double execution; large; expression functions must match the server's | 

C3 is a future route that slots in *underneath* C2 as another `IDataset`; it does not replace a query store.

### D. Component API: HOC, hooks, or both

The HOC is the ergonomic win and the preload contract. Hooks are the right unit for subscriptions and for the cases the HOC cannot express:

- more than one query in a component;
- a query that depends on local state or props (search input, selected tab);
- conditional fetching;
- data in a component that is not "about" one subject;
- custom loading/error UI without `loader`/`errorElement` props.

Proposal: implement one hook and build the HOCs on it, then export the hook.

```tsx
// Core primitive (internal name may differ)
const {data, loading, error, notFound, refresh, patch} =
  useLinked(Team.select((t) => [t.name, t.members.size()]), of, options?);

const {data, loading, error, refresh, page} =
  useLinkedSet(Person.select((p) => p.name).limit(10), of?);

// HOC becomes a thin wrapper
const TeamHeader = linkedComponent(query, ({name, members, source, _refresh}) => ...);
// ≈ (props) => { const r = useLinked(query, props.of); return r.loading ? loader : fn({...r.data, source, _refresh}) }
```

Hooks and preload: a hook-only component has no static `.query`, so `p.bestFriend.preloadFor(Comp)` cannot see it. Keep the HOC for preloadable leaf components, or offer `withQuery(Comp, query)` that sets `Comp.query` without wrapping rendering. Both are small.

`LinkedComponentClass` stays as is; it receives `source` from the HOC and needs nothing new.

### E. Optimistic local patching (the question's "option 1")

Feasible as a thin, bounded layer on top of C2, not as the mechanism:

- `update(...).for(id)` setting literal values on properties a live entry projects at the row with that `id` → patch the cached row immediately (immutable copy), mark the entry stale, refetch to confirm.
- `@add`/`@remove` on a relation projected as bare references → patch the id list; nested fields unknown → leave to refetch.
- Counts (`size()`), filtered relations, sorted/paginated lists, computed expressions → no local derivation; refetch only.

The question's instinct is right: deriving the new count locally means re-implementing query semantics client-side. Patching only what the mutation literally states keeps this layer trivially correct, and the confirming refetch catches everything else. Opt-in per app or per query (`optimistic: true`), off by default in the first release.

## 5. Routes

### Route 1 — Minimal invalidation bus (A1 + B2 + C1 + D1)

Keep both HOCs. Add a dispatch wrapper that emits change descriptors. Each wrapper instance registers `{query deps, result ids}` on mount and refetches when a descriptor matches.

- Pros: smallest change (~250 lines), no new concepts, keeps all existing tests.
- Cons: still no cache or dedup; refetch storms when many instances share a subject; no path to Suspense/SSR; the rough edges in §3 remain unless fixed separately; the dependency logic would later have to be moved into a store anyway.

### Route 2 — Query store with automatic invalidation, HOCs rebuilt on a hook (A1 + B3 + C2 + D1 + D2) — recommended

A `QueryStore` singleton (per `globalThis`, same reasoning core uses for the dispatch) holds live entries. `useLinked`/`useLinkedSet` subscribe through `useSyncExternalStore`. The dispatch wrapper feeds selects into the store (dedup, cache) and mutations into the matcher. HOCs keep their public contract and are reimplemented on the hooks. `invalidate()` is exported for manual and server-driven cases. Query context changes rerun pending queries via `subscribeQueryContext`.

- Pros: solves the stated problem automatically and precisely; fixes §3 by construction (one data path, sequence guards, store-init check at fetch time); request dedup and sharing; a clean base for optimistic patches, Suspense, SSR hydration, devtools, server push, and a later local replica; hooks become public without a second implementation.
- Cons: the largest first step of the three (store, matcher, hook, HOC rewrite ≈ 800–1,000 lines plus tests); the dispatch wrapper is slightly fragile until core offers an event (A3); needs careful race handling.

### Route 3 — Explicit invalidation, SWR-style (A4 + C2 + D2)

Same store and hooks as Route 2 but no automatic matching. Mutations are plain core calls; the author calls `invalidate(Team)` or `invalidate({id: teamId})`, or passes `{refetchOn: [Team]}` to a hook.

- Pros: zero magic; nothing can over-invalidate; simplest matcher.
- Cons: the thing the question wants is exactly the part left to the author; every forgotten `invalidate` is a stale screen. Its primitives (`invalidate`, per-query `refetchOn`) are worth shipping inside Route 2 as the escape hatch.

### Route 4 — Local replica (C3)

Client-side `@_linked/rdf-mem-store` as a write-through cache; the query store executes against it first.

- Pros: every projection updates locally including counts; offline; one source of truth on the client.
- Cons: needs partial-data semantics that core does not have today; double execution; expression parity with the server; a far larger project. Revisit after Route 2 is in and real usage shows where local derivation actually matters.

## 6. Recommendation

Route 2, delivered in phases so each is independently valuable and testable (per the react AGENTS.md workflow, one commit per phase):

1. **QueryStore + `useLinked` + HOCs on top (behavior parity).** Canonical keys, dedup, subscribe via `useSyncExternalStore`, sequence guards, `refresh()`/`patch()`, fix §3 items 3–8. Existing behavior and integration tests stay green; add store unit tests with the existing `MockStore`.
2. **Mutation observation + dependency matcher + `invalidate()`.** Dispatch wrapper (lazily re-wrapped), change descriptors, B3 matching, batching per mutation, refetch-once-more if invalidated mid-flight. Tests: the team scenario above with a mock store, plus negative cases (unrelated subject, unrelated property, filter-prop rename, create on an unbound list, delete).
3. **Public hooks, context reactivity, docs.** Export `useLinked`/`useLinkedSet`/`invalidate`/`withQuery`; rerun on `subscribeQueryContext`; README section "Reactivity".
4. **Optional: optimistic patch layer** (§4.E), opt-in.
5. **Later:** Suspense mode (`suspense: true` throws the entry promise), SSR snapshot/hydrate, a core `subscribeQueryDispatch` PR to replace the wrapper, server-push invalidation using the same descriptor format, devtools listing live entries and why each refetched.

### What stays the same for users

```tsx
const TeamHeader = linkedComponent(
  Team.select((t) => [t.name, t.members.size()]),
  ({name, members}) => <h2>{name} ({members})</h2>,
);
<TeamHeader of={{id: teamId}} />
```

### What becomes possible

```tsx
function TeamPage({teamId}) {
  const team = useLinked(Team.select((t) => [t.name, t.members.size()]), {id: teamId});
  const [q, setQ] = useState('');
  const results = useLinkedSet(
    Person.select((p) => p.name).where((p) => p.name.contains(q)).limit(20),
    {enabled: q.length > 1},
  );
  // ...
}

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// TeamHeader, TeamMembers and `team` above refetch and rerender; nothing else does.
```

## 7. Open questions for the plan phase

- Key stability: `toJSON()` evaluates select callbacks through the proxy. Memoize per builder instance (`WeakMap`) and recompute only when a pending context resolves. Measure on a large query.
- GC policy: grace period after last unsubscribe (SWR uses ~5 s); cap entry count.
- Should `of` as a static `QResult` (not from a preloading parent) register a live entry on first invalidation and become self-fetching? Default no; document.
- Where consistency matters (remote stores with replication lag), allow a per-dataset `settleDelay` or a dataset-provided "after write" promise before refetching.
- Mutations run with `exec(target)` bypass the dispatch; document, and let `invalidate()` cover them until core offers an event.
