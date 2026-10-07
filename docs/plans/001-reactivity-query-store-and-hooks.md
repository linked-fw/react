---
summary: Active plan — live queries for Linked. Core gains a framework-free live-query store (two-track templates + instances, dependency-matched invalidation) fed by local mutations, optional dataset change feeds and app-published changes, with `query.subscribe()` usable anywhere; @_linked/react 2.0 rebuilds its HOCs on it and exposes hooks. Route 2 from docs/002-reactivity-and-hooks-routes.md, revised 2026-10-05 to cover subscriptions outside React and remote changes.
status: Implementation
packages: [core, react]
source: docs/002-reactivity-and-hooks-routes.md
---

# Live queries: core store + reactive `@_linked/react`

## 1. Goal and scope

```tsx
const TeamMembers = linkedComponent(Team.select((t) => t.members.name), ({members}) => …);
const TeamHeader  = linkedComponent(Team.select((t) => [t.name, t.members.size()]), ({name, members}) => …);

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// → TeamHeader and TeamMembers refetch and rerender; a PersonCard for someone else does not.

// The same machinery, no React:
const live = Team.select((t) => t.members.name).for({id: teamId}).live((s) => render(s.data));
```

Change sources that drive a refetch: **local** mutations (every `await Shape.update/create/delete`, including `exec(target)`), **remote** changes from a dataset that implements the optional change feed, and **app-published** changes (`publishChange`) for transports the app owns. Manual `invalidate()` and `refresh()` remain as levers.

Phases (each independently shippable, each its own commit and changeset):

| Phase | Repo | Content | Release |
|---|---|---|---|
| C1 | core | `subscribeQueryDispatch`; `queryDependencies`; `mutationEffects` | part of one core **minor** |
| C2 | core | `LiveQueryStore` (templates, instances, indexes, matcher, context re-keying), `.live()` on select, count and ask builders, `invalidate`, `publishChange`, `IDataset.subscribeChanges?`, `prepareQueries` | same core minor |
| R1 | react | HOCs rebuilt on the core store (behaviour parity + D5 additions), public `useLinkedQuery`/`useLinkedSetQuery`/`withQuery`, context reactivity inherited, README | react **2.0.0** |
| later | react | opt-in optimistic patch layer; `LinkedStoreProvider` override; Suspense; SSR hydration; devtools | — |

Out of scope unless pulled in: local replica / normalized graph cache (ideation route 4); renames of the HOC prop contract (rejected in D5). Accepted ideation decisions D1–D10 are reproduced in §11 and remain binding, with the amendments listed in §11.0 (store relocated to core; single react release).

## 2. Architecture overview

```
 ┌──────────────────────────────── @_linked/core ────────────────────────────────────┐
 │ builders ─► getQueryDispatch() ─► LinkedStorage ─► IDataset ──(optional)──┐        │
 │                 │ instrumented                                 subscribeChanges?   │
 │                 ▼                                                        │        │
 │   subscribeQueryDispatch ──► mutationEffects(q, result) ──┐              ▼        │
 │   publishChange({mutation,result} | {effects}) ──────────┼──► LiveQueryStore      │
 │   invalidate(Shape | {id} | query) ──────────────────────┘    templates (deps via  │
 │   subscribeQueryContext ────────────────────────────────────►  queryDependencies) │
 │                                                               instances, indexes, │
 │   query.live() / live.subscribe(listener) ◄───────────────────  matcher, coalescer │
 └──────────────────────────────────────────────────────────────────┬────────────────┘
                                                                    │ LiveQuery handle
 ┌──────────────────────────────── @_linked/react ───────────────────▼────────────────┐
 │ hooks: useLinkedQuery / useLinkedSetQuery / withQuery (useSyncExternalStore)       │
 │ utils/LinkedComponent: linkedComponent / linkedSetComponent (thin, same contract)  │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Core phase C1 — observation and dependency helpers

### 3.1 `subscribeQueryDispatch` (`src/queries/queryDispatch.ts`)

```ts
export type QueryDispatchEvent =
  | {kind: 'select'; query: SelectQuery | CountQuery; result: Promise<unknown>}
  | {kind: 'ask';    query: AskQuery;                 result: Promise<boolean>}
  | {kind: 'create'; query: CreateQuery;              result: Promise<unknown>}
  | {kind: 'update'; query: UpdateQuery;              result: Promise<unknown>}
  | {kind: 'delete'; query: DeleteQuery;              result: Promise<DeleteResponse>};
export function subscribeQueryDispatch(listener: (e: QueryDispatchEvent) => void): () => void;
```

- `setQueryDispatch(d)` stores an **instrumented** copy: each method delegates to `d`, captures the promise, notifies listeners synchronously with `{kind, query, result}`, returns the same promise. A throwing listener is caught and logged, never propagated.
- `resolveMutationDispatch(kind, target)` wraps an explicit `target` the same way, so `exec(target)` is observed.
- Listener set lives on `globalThis.__linkedQueryDispatch` with the dispatch (§12).

### 3.2 `queryDependencies` (new `src/queries/queryDependencies.ts`)

```ts
export type QueryDependencies = {
  /** Predicates read on nodes whose ids appear in the result (root row, projected relation rows). Matched by id. */
  narrow: Set<string>;
  /** Predicates that decide membership or order: where, scoped relation where, minus, exists, sortBy, inner orderBy. Matched template-wide. */
  filter: Set<string>;
  /** Predicates read on nodes whose ids are NOT projected: `size()`/aggregations over relations, computed expressions over traversals, filters on traversals. Matched template-wide. */
  hidden: Set<string>;
  /** Shape IRIs scanned or traversed: root scan, nested shape scans (`as()` casts, minus-by-shape), `valueShape` of every traversed property shape. */
  shapes: Set<string>;
  /** False when bound to subjects (`.for`, `.forAll`, resolved context). */
  unbound: boolean;
};
export function queryDependencies(query: LowerableSelect | LowerableCount | LowerableAsk): QueryDependencies;
```

Implementation on `lower(query)`:

- **Predicates, not property-shape ids.** IR `property` fields are property *shape* ids. Map each to the predicate(s) it writes: the node's `pathExpr` when present, else `findPropertyShapeById(id).path` → `getSimplePathId` or `collectPathUris` for structured paths. Matching on predicates is what makes `Employee.update({name})` reach a `Person.select(p => p.name)` instance (override = different property shape, same `sh:path`), and lets `Team.name`/`Person.name` share `schema:name` safely because ids disambiguate narrow reads. `findPropertyShapeById` moves from `sparql/irToAlgebra.ts` to `shapes/nodeShapeData.ts` (exported, cache kept).
- **Classification.** From `projection[].expression`: a `property_expr` whose `sourceAlias` row id is projected (the root alias, or a traversal alias that is itself projected / mapped in `resultMap`) → `narrow`, and each traversal on the chain to that alias → `narrow` (the parent row carries the child id). A `property_expr` under an `aggregate_expr`, under a `function_expr`/`binary_expr` operand over a *traversal* alias whose id is not projected, or a traversal whose target alias is not projected → `hidden`. Everything referenced from `where`, `orderBy`, `minus`/`exists` patterns, `traverse.filter`, `traverse.innerOrderBy`, `context_property_expr` → `filter`. A traverse in `patterns` reachable from none → `hidden` (conservative). Count: `filter` + shapes. Ask: `filter` + shapes; shapeless ask → all empty.
- **Shapes.** `root.shape`, every `shape_scan` in `patterns`, `findPropertyShapeById(p).valueShape.id` for every traversed property shape.
- `unbound = !(subjectId || subjectIds?.length)`.

### 3.3 `mutationEffects` (same file)

```ts
export type MutationEffects = {
  op: 'create' | 'update' | 'upsert' | 'delete';
  shape: string;                 // routing shape IRI
  props: Set<string>;            // predicates written, incl. nested node descriptions and @add/@remove relations; for delete: every predicate of the shape (informational)
  ids?: Set<string>;             // targetId / ids + ids found in `result` (created node, nested created nodes, added/removed/updatedTo rows); undefined = unknown (forAll, where, delete_all, delete_where)
  membership: Set<string>;       // shapes whose instance set may have changed: target shape for create/upsert/delete + shapes of nested created nodes; empty for a plain update
};
export function mutationEffects(mutation: LowerableCreate | LowerableUpdate | LowerableDelete, result?: unknown): MutationEffects;
```

`lower(mutation)`; walk `IRNodeData.fields` recursively (nested `IRNodeData`, `IRSetModificationValue.add[]`) mapping properties to predicates as in 3.2; ids from the IR and from any `{id: string}` found while walking `result`. `MutationEffects` is the wire-neutral change descriptor used by every change source (§5).

### 3.4 Tests (C1)

`query-dispatch-subscribe.test.ts` (five kinds, `exec(target)`, listener isolation, survives re-`setDefaultDataset`); `query-dependencies.test.ts` (table-driven: simple, nested, scoped where, outer where, sortBy, minus ×3, `as()`, `size()` → hidden, computed over traversal → hidden, preload sub-select → narrow, `selectAll`, inverse/structured path, count, ask, bound/unbound, inherited override → same predicate); `mutation-effects.test.ts` (update literal, `@add`/`@remove`, nested create in update → membership, create with nested + result ids, upsert, delete ids/all/where, forAll/where → `ids` undefined).

## 4. Core phase C2 — `LiveQueryStore` (`src/live/`)

### 4.1 Data model (no DOM, no React)

```ts
// src/live/keys.ts
export type InstanceParams = {
  subject?: string; subjects?: string[];
  contextName?: string;                 // query context the subject comes from (D7)
  limit?: number; offset?: number;
  vars?: Record<string, unknown>;       // reserved for future query variables (D3)
};
export function templateKey(query: SelectBuilder | CountBuilder | AskBuilder): string; // canonical toJSON() minus subject/subjects/limit/offset/one; WeakMap memo per builder
export function splitQuery(query): {templateJson: object; params: InstanceParams};
export function paramsKey(p: InstanceParams): string;

// src/live/LiveQueryStore.ts
export type Template = {
  key: string; name?: string; json: object; builder: SelectBuilder | CountBuilder | AskBuilder;
  kind: 'select' | 'count' | 'ask'; shapeIri?: string;
  deps?: QueryDependencies;            // lazy (first instance) or eager (prepareQueries)
  reactive: boolean;                   // {reactive: false} opt-out
  pinned: boolean;                     // registered by a component definition / prepareQueries → not GC'd
  instances: Map<string, Instance>;
};
export type LiveStatus = 'pending' | 'loading' | 'success' | 'error';
export type LiveState<R = unknown> = {status: LiveStatus; data?: R; error?: Error; notFound: boolean; refreshing: boolean};
export type Instance = {
  template: Template; params: InstanceParams; key: string;
  state: LiveState;                    // stable object identity until it changes (snapshot for useSyncExternalStore)
  seq: number; staleWhileInflight: boolean;
  ids: Set<string>;                    // every `id` in the result tree + subject(s)
  listeners: Set<(s: LiveState) => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
};
export type LiveQuery<R = unknown> = PromiseLike<R> & {
  readonly state: LiveState<R>;
  subscribe(listener: (s: LiveState<R>) => void): () => void;   // Svelte store contract; returns unsubscribe
  refresh(): Promise<void>;
  patch(partial: Partial<R> | ((cur: R) => R)): void;            // carried-over `_refresh(patch)`: local edit, no request, overwritten by the next refetch
  close(): void;                                                  // drop all listeners and release the instance
};
// `await live` resolves with the first successful `data` (rejects on the first error); the handle stays live afterwards.
export class LiveQueryStore {
  template(query, opts?: {name?: string; reactive?: boolean; pinned?: boolean}): Template;
  subscribe<R>(query, listener?: (s: LiveState<R>) => void, opts?): LiveQuery<R>;   // get-or-create instance; first listener starts the fetch
  invalidate(target: ShapeConstructor | {id: string} | SelectBuilder | Template): void;
  publish(change: ChangeEvent): void;                                               // §5
  templates(): ReadonlyArray<{key: string; name?: string; json: object}>;
  prepare(): void;                                                                  // compute deps for all templates (database tuning / devtools)
  reset(): void;                                                                    // tests
}
export function getLiveQueryStore(): LiveQueryStore;   // globalThis.__linkedLiveQueryStore ??= new LiveQueryStore()
export function resetLiveQueryStore(): void;
```

Builder sugar on select, count and ask builders — one verb:

```ts
const live = Team.select((t) => t.members.name).for({id}).live();   // handle
const first = await live;                                            // first data; handle stays live
live.subscribe((s) => reindex(s.data));                              // later results; returns unsubscribe
live.close();
Team.count().live((s) => setTotal(s.data));                          // shorthand: listener as the argument, no options object
Team.count().live({name: 'teamTotal', reactive: false});             // options object only when options are needed
```

**Store resolution (no manual import).** `.live()` calls a tiny `getLiveQueryStore()` registry read on `globalThis`; `src/live/LiveQueryStore.ts` registers itself on import. `@_linked/core`'s barrel (`src/index.ts`, already listed under `sideEffects`) imports the live module, and `@_linked/react` imports it too, so anyone importing core normally or using react never registers anything. Only code that reaches core exclusively through deep paths (`@_linked/core/shapes/Shape`, …) and calls `.live()` sees `Error: live queries are not loaded; import '@_linked/core' or '@_linked/core/live'`. This keeps the IR pipeline out of forwarding-only bundles (report 018) because `QueryBuilder` never imports the store.

### 4.2 Behaviour

- **Fetch**: bind `template.builder` with params (`.for` / `.forAll` / `.limit` / `.offset`), run through `getQueryDispatch()`; the store's own selects are recognised and ignored by the dispatch listener. Pending context → `pending`, no request. `null` single result → `data = null, notFound = true`. Errors → `status 'error'`, previous data retained. Only fetch when `LinkedStorage.isInitialised()`.
- **Structural sharing**: a refetch whose result deep-equals current `data` keeps the reference and does not notify.
- **Lifecycle**: first listener starts the fetch; last `unsubscribe` arms a GC timer (30 s) that drops the instance, then the template unless `pinned`.
- **Dedup**: same template + params → one instance, one inflight request. `seq` drops out-of-order responses; `staleWhileInflight` triggers one more fetch after settle.
- **Context (D7)**: the store subscribes once to `subscribeQueryContext`; instances with `params.contextName === name` re-resolve, re-key, fetch, notify; cleared → `pending`.

## 5. Change sources and matching

### 5.1 Change event contract

```ts
export type ChangeEvent =
  | {effects: MutationEffects}
  | {mutation: MutationJSON; result?: unknown};      // normalised: mutationEffects(fromJSON(mutation), result)
export function publishChange(e: ChangeEvent): void;  // = getLiveQueryStore().publish(e)

// IDataset (optional member)
subscribeChanges?(listener: (e: ChangeEvent) => void): () => void;
/** When true, local effects for mutations routed to this dataset are skipped; the store waits for the dataset's own change event (server-confirmed). */
readonly authoritativeChanges?: boolean;
```

Sources wired by the store:
1. **Local**: `subscribeQueryDispatch` → on mutation kinds, `result.then(res => publish({effects: mutationEffects(query, res)}))`; rejected mutations publish nothing. Skipped when the routed dataset declares `authoritativeChanges`.
2. **Dataset feeds**: for every dataset in `LinkedStorage.getDatasets()` with `subscribeChanges`, subscribe once; re-scan when `setDefaultDataset`/`setDatasetForShapes`/`unsetDatasetForShape` run (`LinkedStorage` gets a tiny `onRoutingChanged(listener)`; same global record). A dataset implementing a websocket/SSE feed broadcasts the mutation DSL-JSON + result the server already has; clients compute effects locally.
3. **App**: `publishChange(...)` for transports the app owns.
4. **Manual**: `invalidate(...)`.

Echo handling: a client's own mutation arrives locally and again as a remote echo. Per-instance coalescing within a 50 ms window collapses them into one refetch; `authoritativeChanges` removes the local one entirely.

### 5.2 Matching rules (D6, refined)

Given `e: MutationEffects` and a template `T` with `deps`. Rules 1–3 are **scoped by shape**: a predicate written on a node of `e.shape` (or of a shape in `e.membership`) can only change nodes of that shape or of a related one in the class hierarchy, so templates whose `deps.shapes` do not intersect that expanded set are skipped (added during implementation; it keeps a `Team` rename away from a `Person` list sorted on the same `schema:name`).

1. **Narrow by id** — `e.ids` known: for each id, `instancesById[id]`; keep instances of templates where `deps.narrow ∩ e.props ≠ ∅`.
2. **Template-wide** — for each `p ∈ e.props`, every template in `templatesByProp[p]` where `p ∈ deps.filter ∪ deps.hidden`: all its instances.
3. **Unknown ids** (`e.ids === undefined`): for each `p ∈ e.props`, all instances of templates where `p ∈ deps.narrow ∪ filter ∪ hidden`.
4. **Membership** — for each shape `s ∈ e.membership`, expanded up and down the class hierarchy: templates in `templatesByShape[s]`:
   - create / upsert: instances with `deps.unbound`;
   - delete: instances with `deps.unbound`, **plus** every instance (bound or not) that mentions a deleted id in `ids`, **plus** bound instances whose `deps.shapes` include `s` (a traversal into the deleted shape may hide the id, e.g. `size()`).
5. Templates with `reactive: false` are skipped. Coalesce per instance in a microtask / 50 ms window; `refresh()` each; inflight → `staleWhileInflight`.

`invalidate(target)`: `ShapeConstructor` → rule 4 (as delete) for that shape; `{id}` → `instancesById[id]`; builder/template → all its instances.

### 5.3 Worked examples (binding test cases)

Shapes: `Team {name: schema:name, members: ex:member → Person, lead: ex:lead → Person}`, `Person {name: schema:name, age: ex:age, email: ex:email, friends: ex:friend, bestFriend: ex:bestFriend}`, `Employee extends Person` (overrides `name`, same path). Live instances:

| Id | Query | narrow | filter / hidden | shapes | unbound | ids |
|---|---|---|---|---|---|---|
| H | `Team.select(t => [t.name, t.members.size()]).for(T1)` | name | hidden: member | Team, Person | no | T1 |
| M | `Team.select(t => t.members.name).for(T1)` | member, name | | Team, Person | no | T1, P1, P2 |
| C | `Person.select(p => [p.name, p.email]).for(P9)` | name, email | | Person | no | P9 |
| L | `Person.select(p => p.name).where(p => p.age.gte(18)).orderBy(p => p.name).limit(20)` | name | filter: age, name | Person | yes | P1..P20 |
| F | `Team.select(t => t.name).where(t => t.lead.equals(P1))` | name | filter: lead | Team, Person | yes | T1, T4 |
| N | `Team.count()` | | | Team | yes | |
| U | `Person.select(p => ({shout: p.bestFriend.name.ucase()})).for(P1)` | | hidden: bestFriend, name | Person | no | P1 |

Clear hits:

| Mutation | effects | refetch | rule |
|---|---|---|---|
| `Team.update({members:{add:[P3]}}).for(T1)` | props member; ids T1,P3 | H (hidden member, rule 2), M (rule 1) | |
| `Person.update({name}).for(P1)` | props name; ids P1 | M (1), L (2: sortBy name), U (2: hidden name) | H untouched: T1 only, name is narrow in H |
| `Person.update({email}).for(P9)` | props email; ids P9 | C | |
| `Team.update({lead: P2}).for(T1)` | props lead; ids T1,P2 | F (2) | |
| `Person.create({name, age: 30})` | membership Person; ids Pnew | L (4), F (4: unbound, traverses Person), U (2: hidden name) | M, C, H bound → untouched |
| `Person.delete(P1)` | membership Person; ids P1 | every instance of a template touching Person: M, L, H, U, F, C (4) | N untouched (Team only) |
| `Employee.update({name}).for(E1)`, E1 ∈ L | props schema:name; ids E1 | L (2), U (2), M if E1 member (1) | predicate identity + class hierarchy |
| `Team.create({name})` | membership Team | N (4), F (4: unbound over Team) | L and U untouched: shape scope is Team, they are Person-only |

Defensive refetches:

| Mutation | refetch | why |
|---|---|---|
| `Person.update({age: 17}).for(P5)`, P5 ∉ L page | L | filter predicate; membership may change (rule 2) |
| `Person.update({name}).forAll()` | H, M, L, C, U | ids unknown (rule 3); H over-refetches via shared `schema:name` — shape narrowing for bulk mutations is a later refinement |
| `Team.update({members:{add:[{name:'New'}]}}).for(T1)` | H, M, L, F, U | nested create → membership Person → unbound L and F (rule 4); U via hidden name within the Person scope |
| `Person.update({name}).for(P7)`, P7 = P1's bestFriend | U | P7's id is not in U's result; `name` is hidden in U (rule 2) |
| `Person.delete(P1)` | H | bound, but shapes include Person via `members` (rule 4 delete) |
| `Person.upsert({name}).for(P1)` | L + holders of P1 | may have created → membership (4) + update by id (1) |

No refetch:

| Mutation | untouched | why |
|---|---|---|
| `Person.update({name}).for(P1)` | H, C | H holds only T1 (narrow `schema:name` decided by ids); C holds P9 |
| `Team.update({members:{add:[P3]}}).for(T1)` | L, C, N, F | no predicate overlap; N membership unchanged |
| `Person.update({friends:{remove:[P2]}}).for(P1)` | M | M holds P1 but does not read `ex:friend` |
| `Person.create(...)` | M, C, H | bound; a new node is linked to nothing yet |
| `Team.update({name}).for(T1)` | N, L, U, C | count has no reads; L, U, C are Person-only and the write is on a Team node (shape scope). H, F and M refetch: they mention T1 and read a name on projected nodes |
| `Document.update({title}).for(D1)` | all | no shared predicate, id or shape |

### 5.4 Tests (C2)

`live-query-store.test.ts` (keys/splitting, dedup, seq, GC, structural sharing, pending context re-key, `.subscribe()`/`.live()` on select/count/ask); `live-matching.test.ts` (every row of §5.3 as a table-driven case against a scripted `IDataset`); `change-sources.test.ts` (local via dispatch, `exec(target)`, dataset `subscribeChanges`, `publishChange` with mutation JSON and with effects, echo coalescing, `authoritativeChanges`, `invalidate`).

## 6. React phase R1 — rebuild on the core store

### 6.1 Hooks (`src/hooks/`)

```ts
export function useLinkedQuery<Q>(query: Q, of?: OfInput, options?: LinkedOptions): {data, loading, refreshing, error, notFound, refresh, patch};
export function useLinkedSetQuery<Q>(query: Q, of?: SetOfInput, options?: LinkedOptions): {data, loading, refreshing, error, refresh, patch, page};
export function withQuery<C>(component: C, query: SelectBuilder): C & {query; shape};
export type LinkedOptions = {enabled?: boolean; reactive?: boolean; name?: string};
// internal: useLiveQuery(live: LiveQuery | null) = useSyncExternalStore(live.subscribe, () => live.state)
```

Names parallel `linkedComponent` / `linkedSetComponent` and avoid colliding with React Query's `useQuery`. There is no public `useLiveQuery`: `useLinkedQuery(boundQuery)` with no `of`, including `Team.count()` or an ask builder, already returns the live state. `of` accepts `{id}` | Shape | QResult (sets: ShapeSet | QResult[]) and is optional when the builder is bound. Paging state lives in the hook and feeds params; `page.setLimit` resets `index`. A complete QResult in `of` renders synchronously with no instance (D5 preloaded children). `loading` = no data yet; `refreshing` = data present, fetch in flight.

**When to use a hook instead of the HOC.** The HOC remains the default: it carries the static `query`/`shape` that `preloadFor` and the package registry discover, and it is implemented on the hook, so there is one data path. Reach for the hook when the HOC shape (one component, one template, one `of` subject) does not fit: several queries in one component, a query depending on local state (search input, selected tab), conditional fetching (`enabled`), an inline count or ask, data with no `of` subject (dashboard tiles over unbound lists), or wrapping a third-party component with its own render contract. `withQuery(Comp, query)` gives a hook-based component the same discovery as a HOC (statics + package registration, pinned template). Templates created by bare hooks are GC'd when idle; HOC/`withQuery` templates are pinned and appear in `prepareQueries()`.

### 6.2 HOCs (`src/utils/LinkedComponent.ts`)

Contract preserved: factory overloads, `of` → `source`/`sources`, result keys as props, `_refresh()`/`_refresh(patch)`, `linkedData`, `query` paging prop, `loader`/`errorElement`/`'rethrow'`, `LinkedComponentDefaults`, `.query`/`.shape`/`.original`, package registration, `LinkedComponentClass`. Additions (D5): `_refreshing`, `notFoundElement` option/prop, `name`/`reactive` options; template registered **pinned** at definition time from the subject-less builder. Behaviour (D5): data stays during refetches; `of` change renders cached data when present; no revalidate-on-mount. Rough edges from ideation §3 fixed by construction.

### 6.3 Exports and docs

Root and `/native` export `useLinkedQuery`, `useLinkedSetQuery`, `withQuery`; core re-exports used by apps (`invalidate`, `publishChange`, `prepareQueries` = `getLiveQueryStore().prepare()` + `.templates()`) are documented as core imports. README: "Reactivity", "Hooks", "Subscribing outside React", "Remote changes". `useQueryContext` clears on unmount if its value is still current. `package.json`: `typecheck` script; peer `@_linked/core` → `^<C2 version>`; changeset `major`.

## 7. Files expected to change

**core**: `src/queries/queryDispatch.ts`; `src/queries/queryDependencies.ts` (new); `src/shapes/nodeShapeData.ts` (+`findPropertyShapeById`); `src/sparql/irToAlgebra.ts` (import); `src/live/{LiveQueryStore,keys,matcher,changes}.ts` (new); `src/queries/{QueryBuilder,CountBuilder,AskBuilder}.ts` (`.subscribe()`/`.live()`); `src/interfaces/IDataset.ts` (`subscribeChanges?`, `authoritativeChanges?`); `src/utils/LinkedStorage.ts` (`onRoutingChanged`); `src/index.ts`; tests in §3.4/§5.4; `README.md`; `documentation/live-queries.md` (new); `.changeset/*.md` (minor).

**react**: `src/hooks/{useLiveQuery(internal),useLinkedQuery,useLinkedSetQuery,withQuery}.ts` (new); `src/utils/LinkedComponent.ts` (slimmed); `src/utils/useQueryContext.ts`; `src/index.ts`; `src/tests/fixtures.ts` (Team/Person/Employee + scripted dataset with mutation methods and `subscribeChanges`); `src/tests/reactivity.test.tsx` (team scenario + remote change via `publishChange`/dataset feed); `src/tests/react-component-behavior.test.tsx` (kept + `_refreshing`, `notFoundElement`, cached `of` change); `package.json`; `README.md`; `.changeset/*.md` (major).

## 8. Potential pitfalls

- **Predicate vs property-shape identity** — both helpers must emit predicates; tests cover an inherited override and a predicate shared by unrelated shapes.
- **Hidden ids** — any projection that traverses without projecting the related id must land in `hidden`; the classification test includes `size()`, computed-over-traversal, and a traversal filter.
- **Store selects observed by the store** — the dispatch listener must ignore the store's own `select` events (tag the bound builder or ignore `kind: 'select'` altogether; the store only consumes mutation kinds).
- **Template key with `.for()` baked in** — `splitQuery` strips `subject/subjects/limit/offset/one`; HOCs register from the definition-time builder.
- **Pending context keys** — `toJSON().subject` is `{"@ctx": name}`; params carry `contextName`.
- **Echo storms** — local + remote echo coalesce per instance within 50 ms; `authoritativeChanges` avoids the local one.
- **Over-invalidation on bulk mutations** — accepted (D6); shape narrowing is a later refinement.
- **Listener before storage** — the store only fetches when `LinkedStorage.isInitialised()`; subscriptions made earlier stay `pending` and fetch when routing changes (`onRoutingChanged`).
- **SSR** — keep today's `typeof window` loader gate in the HOC/hook for now; hydration is a later phase.
- **React 18/19** — `useSyncExternalStore` in both; `forwardRef` kept.
- **GC vs pinned** — component-defined templates are pinned (registry for database tuning); ad-hoc `subscribe()` templates are GC'd when idle.

## 11. Decision log (from ideation; binding, see 11.0 for amendments)

## 11.0 Amendments (2026-10-05, after plan review)

- **D1 (store scope)**: the store lives in **core** (`src/live/`, `globalThis.__linkedLiveQueryStore`), not react; react's future `LinkedStoreProvider` overrides it per subtree. Reason: subscriptions must work outside React and change sources (dataset feeds) are core concerns.
- **D4**: hooks renamed `useLinkedQuery` / `useLinkedSetQuery` (2026-10-07; parallels the HOC names, avoids React Query's `useQuery`). No public `useLiveQuery`; `useLinkedQuery(boundQuery)` covers counts/asks. `.live()` is the single builder entry point; the handle has `subscribe(cb)` (Svelte store contract), is thenable for the first data, accepts a listener directly as `.live(cb)`, and `patch` carries over `_refresh(patch)`. Store resolution via the core barrel + react import, no manual import (§4.1).
- **D6**: `QueryDependencies` gains `hidden`; `projection` is renamed `narrow`; delete also refetches bound instances whose shapes include the deleted shape (§5.2). Remote and app-published change sources added (§5.1).
- **D8**: one core minor (C1 + C2), one react **2.0.0** (R1). The interim react 1.7.0 is dropped because the store no longer lives in react.
- **D10**: `src/store/` moves to core `src/live/`; react keeps `src/hooks/` and the slimmed HOC file.



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


## 12. Architecture compliance

Discovered with `npx semantu-agents docs architecture`:

- **react**: none found.
- **core** `docs/architecture/runtime-instances.md` — single module instance per runtime; process-wide state is `globalThis`-backed; only plain data crosses runtimes; never construct live `Shape` instances. **Compliance**: dispatch listeners on `globalThis.__linkedQueryDispatch`; live store on `globalThis.__linkedLiveQueryStore`; routing-change listeners on `globalThis.__linkedStorageRouting`; the store holds plain rows and `{id}` params; `ChangeEvent`/`MutationEffects` are plain data and the DSL-JSON variant crosses the client/server boundary unchanged.
- **core** `docs/architecture/publishing.md` — changesets required; dev → main flow; publishing only with explicit consent. **Compliance**: core C1+C2 under one `minor` changeset; react R1 under a `major` changeset.
- **core** `docs/architecture/ontologies.md` — not applicable.

Approved architecture extension (core): an observation point on the dispatch, two IR-derived helpers, a live-query store with change sources, two optional `IDataset` members, and a routing-change listener on `LinkedStorage`. No routing or lowering behaviour changes. Documented in `documentation/live-queries.md`.

## 13. Test strategy

| Package | Quick gate after each phase (~1–2 min) | Full / slow (review) | Source |
|---|---|---|---|
| core | `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs --testPathPattern='query-dispatch-subscribe|query-dependencies|mutation-effects|live-'` then `npm run typecheck` | `npm test` (full unit + typecheck), `npm run test:fuseki` (Docker) — deferred to review | `package.json` scripts |
| react | `npm test` (jest + jsdom, ~8 s) + new `npm run typecheck` | `npm run test:integration` (Docker Fuseki; needs `../core/src/test-helpers`) — deferred, Docker not in this package's CI | `package.json`, `jest.config.cjs` |

Phase validation: C1 → §3.4 suites + full core `npm test`; C2 → §5.4 suites (every §5.3 row) + full core `npm test`; R1 → behaviour suite green unchanged + new HOC cases + `reactivity.test.tsx` (team scenario local, remote via `publishChange`, dataset feed, unrelated card untouched) + hook tests.

## 14. Remaining unclear areas

- Echo window (50 ms) and GC grace (30 s) defaults.
- Whether `authoritativeChanges` should be per-dataset only (plan) or also settable per mutation.
- Async iteration on `LiveQuery` (`for await`) — deferred; add if a consumer asks.
- `prepareQueries` naming: core `getLiveQueryStore().prepare()` + `templates()`; react may re-export a `prepareQueries()` convenience.
- Core version produced by changesets → react peer range `^<that>`.

## 15. Tasks

### Dependency graph

```
C1a (dispatch event) ──┐
                        ├─► C2a (store core) ─► C2b (change sources + matcher) ─► C3 (docs, changeset, build) ─► R1a ─► R1b ─► R1c
C1b (deps helpers) ────┘
```

- **Parallel group 1**: C1a ∥ C1b (disjoint files; C1b also creates the shared live fixtures).
- C2a needs C1b's `queryDependencies` only for `Template.deps`; it may stub `deps` as `undefined` until C2b, but with C1b done first no stub is needed.
- React phases run after C3 and are sequential (they edit the same files). R1a can start against a locally built core (`npm run build` in core, then `npm install --no-save ../core` in react) before the core minor is published.
- Every phase: one commit per repository, plan doc updated in the same commit (the plan lives in the react repo; core commits reference `react/docs/plans/001`).

Quick gates (run after every phase in that repo):
- core: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs --testPathPattern='<phase pattern>'` then `npm run typecheck` (both exit 0). Fuseki `globalSetup` only warns when Docker is absent.
- react: `npm test` then `npm run typecheck` (added in R1a), both exit 0.
Full review gate: core `npm test`; react `npm test`; Fuseki suites (`core npm run test:fuseki`, `react npm run test:integration`) only where Docker exists, otherwise reported as skipped.

---

### Phase C1a — `subscribeQueryDispatch` (core)

Files: `src/queries/queryDispatch.ts`, `src/index.ts`, `src/tests/query-dispatch-subscribe.test.ts`.

Tasks:
1. Add to `queryDispatch.ts`:
   ```ts
   export type QueryDispatchEvent = {kind: 'select'|'ask'|'create'|'update'|'delete'; query: unknown; result: Promise<unknown>};
   export function subscribeQueryDispatch(listener: (e: QueryDispatchEvent) => void): () => void;
   ```
   Listener set on `globalThis.__linkedQueryDispatch.listeners` (create the record field if absent so a second module copy shares it).
2. `instrumentDispatch(d: QueryDispatch): QueryDispatch` — returns an object whose five methods call `d.<m>(q)`, wrap the returned value in `Promise.resolve(...)` as `result`, notify every listener (`for (const l of [...listeners]) try { l({kind, query: q, result}) } catch (e) { console.error('[linked] dispatch listener failed', e) }`), and return `result`. Tag the instrumented object with a non-enumerable `__instrumented = true` so `setQueryDispatch` never double-wraps.
3. `setQueryDispatch(d)` stores `instrumentDispatch(d)`; `getQueryDispatch()` unchanged. `resolveMutationDispatch(kind, target)` returns `instrumentDispatch(target)` for an explicit target (after the existing method check).
4. Export `subscribeQueryDispatch` and the `QueryDispatchEvent` type from `src/index.ts` next to `subscribeQueryContext`.

Validation — `src/tests/query-dispatch-subscribe.test.ts` (scripted `IDataset` literal like `store-routing.test.ts`, `LinkedStorage.setDefaultDataset(store)`):
- `emits select/ask/create/update/delete` — run `RoutedPerson.select()`, `RoutedPerson.exists('…')`, `RoutedPerson.create({})`, `RoutedPerson.update({}).for(id)` (use a shape with one literal property), `RoutedPerson.delete(id)`; assert the listener received five events in order with `kind` matching and `event.query` being the same builder object (`toBe`), and `await event.result` equals what the store returned.
- `exec(target) is observed` — `RoutedPerson.update({...}).for(id).exec(otherStore)`; assert one `update` event, and `otherStore` was called (not the default).
- `listener errors are isolated` — a throwing listener plus a second listener; assert the mutation still resolves and the second listener ran; `console.error` spied and called once.
- `survives setDefaultDataset` — subscribe, call `setDefaultDataset` twice, run a select; assert exactly one event.
- `unsubscribe stops events` — assert no further events after calling the returned function.
Quick gate pattern: `query-dispatch-subscribe`. Expected: 5 tests pass; typecheck exit 0.

---

### Phase C1b — dependency helpers + live fixtures (core)

Files: `src/shapes/nodeShapeData.ts` (+`findPropertyShapeById`, moved from `src/sparql/irToAlgebra.ts` with its version-keyed cache; irToAlgebra imports it), `src/queries/queryDependencies.ts` (new; exports `queryDependencies`, `mutationEffects`, types `QueryDependencies`, `MutationEffects`), `src/index.ts`, `src/test-helpers/live-fixtures.ts` (new), `src/tests/query-dependencies.test.ts`, `src/tests/mutation-effects.test.ts`.

Shared fixtures (`live-fixtures.ts`, package name `live-fixtures`, explicit predicate IRIs so `Team.name` and `Person.name` share `http://schema.org/name`):
```ts
Person  { name: schema:name (maxCount 1); age: ex:age (xsd:integer, maxCount 1); email: ex:email (maxCount 1);
          friends: ex:friend → Person; bestFriend: ex:bestFriend → Person (maxCount 1) }
Employee extends Person { name: schema:name (override, required, maxCount 1); employeeId: ex:employeeId }
Team    { name: schema:name (maxCount 1); members: ex:member → Person; lead: ex:lead → Person (maxCount 1) }
```
Also export `ids` helpers (`T1`, `P1`…) and a `predicate(label)` helper returning the IRI for assertions.

Tasks:
1. `predicatesOf(propertyShapeId: string, pathExpr?: PathExpr): string[]` — `pathExpr` → `collectPathUris(pathExpr)`; else `findPropertyShapeById(id)` → `getSimplePathId(path) ?? collectPathUris(path)`; unknown id → `[id]` (never empty).
2. `queryDependencies(query)`: `const ir = lower(query)`; handle `kind` `'select' | 'count' | 'ask'`.
   - Build `traverseByTo: Map<alias, IRTraversePattern>` from a recursive walk of `root`/`patterns` (join/optional/union/exists/minus children). Record every `shape_scan.shape` into `shapes`; for every traverse add `predicatesOf(property, pathExpr)` to a per-alias predicate list and `findPropertyShapeById(property)?.valueShape?.id` to `shapes`.
   - `chain(alias)`: walk `traverseByTo` from `alias` back to root, collecting each traversal's predicates.
   - For each `projection[i].expression`: if `property_expr` → `narrow += predicatesOf(expr) + chain(expr.sourceAlias)`; if `alias_expr` → `narrow += chain(alias)`; otherwise (aggregate/function/binary/logical/not/in/…) → recursively collect every `property_expr` inside into `hidden` together with `chain(sourceAlias)`; `context_property_expr` → `filter`.
   - `where`, `orderBy[].expression`, `traverse.filter`, `traverse.innerOrderBy[].property`, `minus.filter`, `exists_expr` sub-patterns: every `property_expr`/`context_property_expr` predicate and the chain of its `sourceAlias` → `filter`. A traverse that is part of a `minus` or `exists` pattern → its predicates → `filter`.
   - Any traverse not reached by the steps above → `hidden`.
   - `unbound = !(ir.subjectId || ir.subjectIds?.length)` (ask: `!ir.subjectId`).
3. `mutationEffects(mutation, result?)`: `const ir = lower(mutation)`; map kinds: `create`→`create`, `update`/`update_where`→`update`, `upsert`→`upsert`, `delete`/`delete_all`/`delete_where`→`delete`. `props`: walk `IRNodeData.fields` recursively (`IRNodeData` values, arrays, `IRSetModificationValue.add[]`), `predicatesOf(field.property)`; for delete kinds: predicates of every property shape of the shape (`getPropertyShapes(shape, true)`). `ids`: `update`/`upsert` → `{ir.id}`; `delete` → `ir.ids[].id`; `create` → `ir.data.id` if present; nested `IRNodeData.id`s; plus every `id` string found by walking `result` (objects/arrays, any depth); `update_where`/`delete_all`/`delete_where` → `undefined`. `membership`: `create`/`upsert`/`delete` → `{ir.shape}`; plus `IRNodeData.shape` of every nested node description under `add`/arrays/values for any op.
4. Export both functions and types from `src/index.ts`.

Validation — `src/tests/query-dependencies.test.ts` (each case asserts the exact sets, using `predicate('name')` etc.):
- `simple projection` — `Team.select(t => t.name).for(T1)`: narrow {schema:name}, filter ∅, hidden ∅, shapes {Team}, unbound false.
- `nested path` — `Team.select(t => t.members.name)`: narrow {ex:member, schema:name}, shapes {Team, Person}, unbound true.
- `size over relation` — `Team.select(t => [t.name, t.members.size()]).for(T1)`: narrow {schema:name}, hidden {ex:member}, shapes {Team, Person}.
- `computed over traversal` — `Person.select(p => ({shout: p.bestFriend.name.ucase()})).for(P1)`: hidden {ex:bestFriend, schema:name}, narrow ∅.
- `outer where + sortBy` — `Person.select(p => p.name).where(p => p.age.gte(18)).orderBy(p => p.name)`: narrow {schema:name}, filter {ex:age, schema:name}.
- `scoped where` — `Team.select(t => t.members.where(m => m.age.gt(30)).name)`: narrow {ex:member, schema:name}, filter {ex:age}.
- `where on relation` — `Team.select(t => t.name).where(t => t.lead.equals(P1))`: filter {ex:lead}, shapes {Team, Person}.
- `minus by shape / by property / by condition` — three cases; assert `shapes` includes the minus shape, and property/condition predicates land in `filter`.
- `as() cast` — `Person.select(p => p.friends.as(Employee).employeeId)`: shapes include Employee.
- `preload sub-select` — `Person.select(p => [p.name, p.bestFriend.preloadFor({query: Person.select(f => f.email)})])`: narrow includes ex:bestFriend and ex:email.
- `selectAll` — `Person.selectAll()`: narrow ⊇ {schema:name, ex:age, ex:email, ex:friend, ex:bestFriend}.
- `count` — `Person.select().where(p => p.age.gte(18)).toCount()`: narrow ∅, filter {ex:age}, unbound true.
- `ask` — `AskBuilder.of({shapeClass: Person, subject: {id: P1}})`: shapes {Person}, unbound false; shapeless `AskBuilder.forNode(P1)`: all sets empty.
- `inherited override uses the same predicate` — `Employee.select(e => e.name)` narrow equals `Person.select(p => p.name)` narrow.
- `structured path` — a fixture property with `path: {inv: ex:member}` on Person (`teams`): `Person.select(p => p.teams.name)` narrow ⊇ {ex:member}.

`src/tests/mutation-effects.test.ts`:
- `update literal` — `Person.update({name: 'X'}).for(P1)`: op update, props {schema:name}, ids {P1}, membership ∅.
- `set add/remove` — `Team.update({members: {add: [{id: P3}], remove: [{id: P2}]}}).for(T1)`: props {ex:member}, ids {T1} before result; with `result = {id: T1, members: {added: [{id: P3}], removed: [{id: P2}]}}` → ids {T1, P3, P2}.
- `nested create in update` — `Team.update({members: {add: [{name: 'New'}]}}).for(T1)` with result containing the new row: props {ex:member, schema:name}, membership {Person}, ids include the new id.
- `create` — `Person.create({name: 'A', friends: [{id: P2}]})` with result `{id: Pn, …}`: op create, props {schema:name, ex:friend}, membership {Person}, ids {Pn, P2}.
- `upsert` — `Person.upsert({name: 'A'}).for(P1)`: op upsert, membership {Person}, ids {P1}.
- `delete ids` — `Person.delete([{id: P1}, {id: P2}])`: op delete, ids {P1, P2}, membership {Person}, props ⊇ {schema:name, ex:age}.
- `delete all / where`, `update forAll / where` — `ids` undefined; props as written.
- `upsert via JSON round trip` — `mutationEffects(fromJSON(builder.toJSON()))` equals `mutationEffects(builder)` for the update and create cases.
Quick gate pattern: `query-dependencies|mutation-effects` plus the existing SPARQL golden suites (`sparql-select-golden|ir-select-golden`) to prove the `findPropertyShapeById` move is behaviour-neutral; typecheck exit 0.

---

### Phase C2a — `LiveQueryStore`, `LiveQuery` handle, `.live()` (core)

Files: `src/live/registry.ts` (new, tiny: `getLiveQueryStore()` reading `globalThis.__linkedLiveQueryStore`, throws the "not loaded" error), `src/live/keys.ts`, `src/live/LiveQueryStore.ts`, `src/live.ts` (barrel for `@_linked/core/live`, re-exports + side-effect import of the store), `src/index.ts` (`import './live.js'` + re-exports), `src/queries/QueryBuilder.ts`, `src/queries/CountBuilder.ts`, `src/queries/AskBuilder.ts` (`.live()` each, importing only `registry.ts`), `src/tests/live-query-store.test.ts`.

Contracts: §4.1 (`InstanceParams`, `Template`, `LiveState`, `Instance`, `LiveQuery`, `LiveQueryStore`), §4.2 behaviour. In this phase `Template.deps` is computed via `queryDependencies` but not yet consumed (no matcher).

Tasks:
1. `keys.ts`: `splitQuery(SelectBuilder)` → `{templateJson, params}` from `toJSON()`: strip `subject`, `subjects`, `limit`, `offset`, `one`; `params.subject` = string subject; `isContextRefJSON(subject)` → `params.contextName = subject['@ctx']` and `params.subject = resolveContextId(name, false) ?? undefined`. Count/ask builders: template = full `toJSON()`, params `{}`. `templateKey` = `JSON.stringify(templateJson)` memoized in a `WeakMap<object, string>`; `paramsKey` = `JSON.stringify` of params with sorted keys.
2. `LiveQueryStore`: `template()`, `subscribe()`, `invalidate()` (stub throwing "implemented in C2b" is NOT acceptable — implement the `{id}`/builder/template forms here; the shape form lands in C2b), `templates()`, `prepare()`, `reset()`, and the internal fetch: bind params (`builder.for(subject)` / `.forAll(subjects)` / `.limit` / `.offset`; count/ask: run as is), `await getQueryDispatch().selectQuery(bound)` / `askQuery`; for counts call `resolveCount`; for asks `resolveExistence`. `seq` guard; `staleWhileInflight`; structural sharing via a small deep-equal; `ids` collected from the result tree; GC timer 30 s (configurable via `store.options.gcMs`); `LinkedStorage.isInitialised()` guard → state `pending`.
3. `LiveQuery` handle: `state` getter, `subscribe(cb)` (adds listener; calls nothing synchronously), `then(onF, onR)` (resolves with the first `success` data, rejects on first `error`; if already success resolve immediately), `refresh()`, `patch()`, `close()` (removes all listeners created through this handle and unsubscribes).
4. `.live(listenerOrOpts?, opts?)` on the three builders: `getLiveQueryStore().subscribe(this, listener, opts)`.
5. Context re-key: store subscribes to `subscribeQueryContext`; instances with `params.contextName === name` → compute new params, move listeners to the new instance (get-or-create), fetch; cleared → `pending`.
6. Registration: `LiveQueryStore.ts` ends with `globalThis.__linkedLiveQueryStore ??= new LiveQueryStore()`; `src/live.ts` imports it; `src/index.ts` imports `./live.js`. Add `"./live"` to `package.json` `sideEffects` (`**/live.js`, `**/live.ts`) so bundlers keep the registration.

Validation — `src/tests/live-query-store.test.ts` (scripted dataset returning canned rows per subject; `resetLiveQueryStore()` in `beforeEach`; fake timers for GC):
- `splitQuery strips instance params` — `Team.select(t => t.name).for(T1).limit(5)` → templateJson has no subject/limit; params `{subject: T1, limit: 5}`; `templateKey` identical for `.for(T1)` and `.for(T2)`.
- `pending context params` — `.for(getQueryContext('user'))` before set → `params.contextName === 'user'`, `subject` undefined; after `setQueryContext('user', {id: P1}, Person)` → subject P1.
- `first subscriber fetches, second shares` — two `live()` handles on the same bound query: store called once; both receive `success` with the same `data` reference.
- `thenable resolves with first data` — `await Team.select(t => t.name).for(T1).live()` equals the canned row.
- `null result → notFound` — subject with no row: `state.notFound === true`, `data === null`.
- `error keeps previous data` — second fetch rejects: `status 'error'`, `error` set, `data` unchanged.
- `seq drops stale response` — two `refresh()` calls where the first resolves last: final `data` is the second response.
- `structural sharing` — refetch with deep-equal rows: listener not called, `data` reference unchanged.
- `ids collected` — nested result `{id: T1, members: [{id: P1}, {id: P2}]}` → instance ids {T1, P1, P2} (exposed via `store.inspect(instanceKey)` test helper or a `__instances` accessor marked `@internal`).
- `GC after close` — `close()`, advance 30 s: `store.templates()` no longer lists an unpinned template; pinned template stays.
- `context re-key` — subscribe with pending context, set the context: fetch happens, listener receives data; clear the context: state back to `pending`.
- `count and ask live` — `Person.select().toCount().live()` resolves a number; `AskBuilder.forNode(P1).live()` resolves a boolean.
- `.live() without store registered throws the documented error` — delete `globalThis.__linkedLiveQueryStore`, call `.live()`, assert the message mentions `@_linked/core/live`; restore.
Quick gate pattern: `live-query-store`; typecheck exit 0.

---

### Phase C2b — change sources + matcher (core)

Files: `src/live/matcher.ts`, `src/live/changes.ts`, `src/live/LiveQueryStore.ts` (wire sources, indexes, `publish`, shape form of `invalidate`), `src/interfaces/IDataset.ts` (`subscribeChanges?`, `authoritativeChanges?`), `src/utils/LinkedStorage.ts` (`onRoutingChanged(listener)` notified from `setDefaultDataset`, `setDatasetForShapes`, `unsetDatasetForShape`), `src/index.ts` + `src/live.ts` (`publishChange`, `invalidate`, `ChangeEvent`), `src/tests/live-matching.test.ts`, `src/tests/change-sources.test.ts`.

Tasks:
1. `changes.ts`: `normalizeChange(e: ChangeEvent): MutationEffects` (`effects` passthrough; `{mutation, result}` → `mutationEffects(fromJSON(mutation), result)`); `effectsHash(e)` (op|shape|sorted props|sorted ids) for the 50 ms echo dedup.
2. Indexes on the store: `templatesByProp`, `templatesByShape` (filled when `deps` are computed; `prepare()` fills all), `instancesById` (updated on every result; old ids removed).
3. `matcher.ts`: `selectInstances(store, effects): Set<Instance>` implementing §5.2 rules 1–5 exactly; shape expansion via `getSuperShapes`/`getSubShapes` on the `NodeShapeData` resolved with `getShapeClass(iri)?.shape`.
4. `LiveQueryStore.publish(e)`: normalize → dedup by hash within `options.echoMs` (50) → `selectInstances` → for each: if inflight → `staleWhileInflight = true`, else `refresh()`; all scheduled in one microtask.
5. Wire sources in the store constructor: `subscribeQueryDispatch` (mutation kinds only; `result.then(res => publish({effects: mutationEffects(query, res)}), () => {})`; skip when the dataset that `LinkedStorage` resolves for `query.shape` has `authoritativeChanges`); dataset feeds: `(re)scanDatasets()` on construction and on `onRoutingChanged`, subscribing once per dataset object (`WeakSet`); `invalidate(ShapeConstructor)` → publish a synthetic delete-like effect `{op: 'delete', shape, props: ∅, ids: undefined, membership: {shape}}` so rule 4 applies.
6. Exports: `publishChange`, `invalidate`, `ChangeEvent` from `src/live.ts` and `src/index.ts`.

Validation — `src/tests/live-matching.test.ts`: build the seven instances of §5.3 against a scripted dataset returning the rows listed there; for **every row of the three tables in §5.3** one test: run the mutation through the dispatch (or `publishChange` with the effects), flush microtasks, assert the set of instances whose fetch count increased equals the expected set and all others are unchanged. Plus: `reactive:false template never refetches`; `invalidate(Person)` refetches L, M, H, C and not N; `invalidate({id: P9})` refetches C only.
`src/tests/change-sources.test.ts`: `local mutation via dispatch triggers refetch`; `exec(target) mutation triggers refetch`; `dataset subscribeChanges with mutation JSON` (dataset emits `{mutation: builder.toJSON(), result}` → same refetch set as local); `dataset subscribeChanges with effects`; `publishChange from app code`; `echo within 50 ms is one refetch` (local then feed with identical effects: fetch count +1); `authoritativeChanges skips local` (dataset flagged: local mutation causes no refetch; its feed event does); `routing change re-scans datasets` (new default dataset with a feed registered after store creation gets subscribed); `rejected mutation publishes nothing`.
Quick gate pattern: `live-`; typecheck exit 0.

---

### Phase C3 — core docs, changeset, build (core)

Files: `documentation/live-queries.md` (new), `README.md` (new section "Live queries" with the §1 example, `.live()` handle, change sources, `invalidate`, dataset feed contract, `prepare()`), `.changeset/<name>.md` (`"@_linked/core": minor`), `package.json` `sideEffects`.

Validation: `npm run build` exit 0 and `lib/esm/live.js` exists; `node -e "import('@_linked/core').then(m => console.log(typeof m.subscribeQueryDispatch, typeof m.queryDependencies, typeof m.publishChange))"` from a scratch dir with the built package linked prints `function function function`; `node -e` importing `./lib/esm/queries/QueryBuilder.js` alone and calling `.live()` on a builder throws the documented error (proves the registry path); full `npm test` green (report counts).

---

### Phase R1a — hooks (react)

Prereq: core built (`npm run build` in `../core`), `npm install --no-save ../core` in react so `node_modules/@_linked/core` is the local build.

Files: `package.json` (`"typecheck": "tsc -p tsconfig-test.json --noEmit"`), `src/hooks/useLiveQuery.ts` (internal), `src/hooks/useLinkedQuery.ts`, `src/hooks/useLinkedSetQuery.ts`, `src/hooks/withQuery.ts`, `src/hooks/of.ts` (shared `of` binding: `{id}`/Shape/QResult → subject id; ShapeSet/QResult[] → subjects; `isValidQResult` moved here from `LinkedComponent.ts`), `src/tests/fixtures.ts` (Team/Person/Employee shapes via `linkedShape`, a `ScriptedDataset` implementing select/ask/update/create/delete and `subscribeChanges` with an `emit()` test hook), `src/tests/hooks.test.tsx`.

Contracts: §6.1. `useLiveQuery(live: LiveQuery | null)` = `useSyncExternalStore(live ? live.subscribe : noop, () => live?.state ?? IDLE)`. `useLinkedQuery(query, of?, opts)`: compute `bound = of ? query.for(subjectOf(of)) : query`; `const live = useMemo(() => enabled && !preloaded ? bound.live(opts) : null, [templateKey(query), subjectId, enabled])`; `useEffect(() => () => live?.close(), [live])`; return `{data: preloaded ?? state.data, loading, refreshing, error, notFound, refresh, patch}`. `useLinkedSetQuery` adds `useState` for `limit`/`offset`, binds `.forAll(subjects).limit(l).offset(o)`, returns `page`. `withQuery(Comp, query)` sets `Comp.query`, `Comp.shape` (via `getShapeClass(query.toJSON().shape)`), registers the pinned template and calls `registerComponent`.

Validation — `src/tests/hooks.test.tsx` (jsdom, `LinkedStorage.setDefaultDataset(new ScriptedDataset())`, `resetLiveQueryStore()` per test):
- `useLinkedQuery loads a subject` — renders `loading` then `data.name === 'Semmy'`.
- `useLinkedQuery with bound builder and no of` — `useLinkedQuery(Person.select(p => p.name).for(P1))` works.
- `useLinkedQuery count` — `useLinkedQuery(Team.select().toCount())` → `data === 3`.
- `preloaded QResult skips fetch` — `of = {id: P1, name: 'X'}`: dataset select count stays 0, `data.name === 'X'`.
- `enabled:false` — no fetch, `loading false`, `data undefined`.
- `of change renders cached data immediately` — mount P1, switch to P2 (not cached) → loader state; switch back to P1 → `loading false` synchronously and no extra fetch.
- `useLinkedSetQuery paging` — `limit(2)`: `page.next()` fetches offset 2; `page.setLimit(3)` resets index 0.
- `refreshing flag` — call `refresh()`: `refreshing true` while pending, data still present.
- `withQuery exposes statics` — `withQuery(Comp, q).query === q`, `.shape === Person`, and `FieldSet.extractComponentFieldSet(Comp)` returns labels `['name']`.
- `unmount closes the live handle` — after unmount and 30 s fake-timer advance, `getLiveQueryStore().templates()` does not list the unpinned template.
Quick gate: `npm test` (existing 35 + new) and `npm run typecheck` exit 0.

---

### Phase R1b — HOCs rebuilt on the hooks (react)

Files: `src/utils/LinkedComponent.ts` (rewrite the two factories on `useLinkedQuery`/`useLinkedSetQuery`; keep types, `normalizeFactoryArgs`, loader/error resolution, `getSourceFromInputProps`; add `notFoundElement` to options/props/defaults and `name`/`reactive` to options; inject `_refreshing`; register pinned templates at definition), `src/tests/react-component-behavior.test.tsx` (keep all; add cases), `src/package.ts` unchanged.

Validation: all existing behaviour and classnames/query-context tests pass unchanged; new cases in `react-component-behavior.test.tsx`:
- `_refreshing is true during _refresh() and data stays rendered` — assert old name still in DOM while refreshing, new name after.
- `notFoundElement renders for a null single result` — definition option and instance prop forms; default (no option) renders the component with empty props as before.
- `set component defined before storage setup still loads` — define the component, then `setDefaultDataset`, then render; assert rows appear (regression for ideation §3 item 3).
- `new ShapeSet each parent render does not refetch` — rerender the parent five times with a fresh `ShapeSet` of the same ids; assert dataset select count is 1 (item 4).
- `fast of change applies the latest response` — deferred responses resolved out of order; assert the DOM shows the latest subject (item 5).
- `pending context resolves without parent rerender` — component bound to `getQueryContext('user')`, `setQueryContext` later; assert data renders (item 6).
Quick gate: `npm test`, `npm run typecheck`.

---

### Phase R1c — reactivity end to end, context cleanup, docs, changeset (react)

Files: `src/tests/reactivity.test.tsx`, `src/utils/useQueryContext.ts` (clear on unmount only if current value is the one set), `src/index.ts` (exports), `src/tests/native-barrel.test.tsx` (assert new exports present on the native entry), `README.md` ("Reactivity", "Hooks", "Subscribing outside React", "Remote changes"; update the "Render lifecycle" and TODO sections), `.changeset/<name>.md` (`"@_linked/react": major` with migration notes: peer floor, no API removals), `package.json` (peer `@_linked/core` placeholder `^<C3 version>`; devDependency bump at wrapup).

Validation — `src/tests/reactivity.test.tsx` (TeamHeader + TeamMembers + PersonCard rendered together over `ScriptedDataset`):
- `adding a member updates header and list, not the card` — `await Team.update({members: {add: [{id: P3}]}}).for({id: T1})`; assert header count text changes and list gains P3; PersonCard fetch count unchanged.
- `renaming a person updates the list only` — `Person.update({name}).for(P1)`.
- `remote change via dataset feed` — `dataset.emit({mutation: Team.update(...).for(T1).toJSON(), result})`; same assertions as the first case.
- `publishChange from app code` — with effects object.
- `invalidate(Team) refetches team components`.
- `reactive:false component ignores changes`.
- `useQueryContext clears on unmount` — mount/unmount a component using it; assert `getQueryContext('user')` is pending afterwards; a second setter with a different value is not cleared by the first's unmount.
Quick gate: `npm test`, `npm run typecheck`, `npm run build` exit 0.

---

### Integration check (end of R1c, before review)

1. `cd core && npm test` (full) and `cd react && npm test && npm run build`.
2. Bundle sanity: `node -e` importing only `@_linked/core/queries/QueryBuilder.js` from the built lib must not load `src/live/LiveQueryStore` (assert `globalThis.__linkedLiveQueryStore` is undefined), while importing `@_linked/core` defines it.
3. Re-read §12 architecture compliance against the diff.

## 16. Implementation log

### Phase C1a — `subscribeQueryDispatch` (core) — completed
- Commit (core): `a56f01a`.
- Done: instrumented dispatch in `queryDispatch.ts` (notify at call time with the result promise, `__instrumented` marker, no double wrap), `resolveMutationDispatch` instruments `exec(target)`, listener set on the shared global record, exports in `src/index.ts`, 6 tests in `src/tests/query-dispatch-subscribe.test.ts`.
- Validation: quick gate (`query-dispatch-subscribe|store-routing|exec-target|count-through-linkedstorage`) 4 suites / 35 tests pass; `npm run typecheck` exit 0; extra sweep of 16 neighbouring suites (434 tests) green.
- Deviations: none. Note: `Shape.exists()` on a subclass goes through `askQuery`, so the five-kind event order holds as specified.

### Phase C1b — dependency helpers + live fixtures (core) — completed
- Commit (core): `ce87509`.
- Done: `queryDependencies` / `mutationEffects` in `src/queries/queryDependencies.ts`; `findPropertyShapeById` moved to `shapes/nodeShapeData.ts` (exported, same cache); `src/test-helpers/live-fixtures.ts` (Team/Person/Employee with shared `schema:name`, `Person.teams` as `{inv: ex:member}` using the `[package, 'Team']` forward reference); 19 + 13 tests.
- Validation: `query-dependencies|mutation-effects|sparql-select-golden|ir-select-golden|sparql-mutation-golden|property-path-sparql` → 6 suites / 278 tests pass; typecheck exit 0 (after the C2a keys fix).
- Deviations (accepted): (1) a scoped relation `where` contributes its predicates to `filter` but its chain stops at that traversal (the relation itself is `narrow` via the projection); (2) `shapes` also records the *declaring* shape of every property read, because `.as(Shape)` casts leave no trace in the IR; (3) value shapes are recorded per property expression as well as per traverse. All three only make matching more conservative.

### Phase C2a — `LiveQueryStore`, handle, `.live()` (core) — completed
- Commit (core): `63534cf`.
- Done: `src/live/{registry,keys,LiveQueryStore}.ts`, `src/live.ts` barrel, `.live()` on select/count/ask builders (via the registry only), root `index.ts` imports `./live.js` and re-exports the API, `package.json` `sideEffects` covers the live entry; 19 tests in `live-query-store.test.ts`.
- Validation: `live-query-store|query-dependencies|mutation-effects|query-dispatch-subscribe` → 57 tests pass; typecheck exit 0. Full core `npm test` after C2a: 90 suites / 2028 tests pass, 4 Fuseki suites skipped (no Docker).
- Deviations: `.for(id)` and `.for(ctx)` imply `one`, so `one` is only a param for subject-less `.one()` queries (keeps keys minimal). The handle exposes `key`. `invalidate` by `{id}`/query/template landed here; the shape form in C2b.

### Phase C2b — change sources + matcher (core) — completed
- Commit (core): `8180076`.
- Done: `src/live/{changes,matcher}.ts`; store wiring (dispatch listener for mutation kinds, dataset feeds with re-scan on `LinkedStorage.onRoutingChanged`, `publish()` with echo folding, microtask batching, `invalidate(Shape|iri)`); `IDataset.subscribeChanges?` / `authoritativeChanges?`; `publishChange` / `invalidate` free functions; 19 matching tests (every §5.3 row) + 12 change-source tests.
- Validation: `live-|query-dispatch-subscribe|query-dependencies|mutation-effects|store-routing|count-through-linkedstorage|exec-target` → 8 suites / 105 tests pass; typecheck exit 0.
- Deviation: shape scoping added to rules 1–3 (see §5.2) after the first run showed the hand-written §5.3 tables had missed shared-predicate consequences; the tables above are corrected to the implemented behaviour.

### Phase C3 — docs, changeset, build (core) — completed
- Commit (core): `f397a2e`.
- Done: `documentation/live-queries.md`, README "Live queries" section + index link, `.changeset/live-queries.md` (minor).
- Validation: `npm run build` exit 0; from a scratch package: deep import of `queries/QueryBuilder.js` leaves `globalThis.__linkedLiveQueryStore` undefined, root import defines it and exports `subscribeQueryDispatch`, `queryDependencies`, `mutationEffects`, `publishChange`, `invalidate`, `getLiveQueryStore`; `@_linked/core/live` resolves.

### Phase R1a — hooks (react) — completed
- Commit (react): `7a3143b`.
- Done: `src/hooks/{of,useLiveQuery,useLinkedQuery,useLinkedSetQuery,withQuery}.ts`; `registerComponent` exported from `package.ts`; `typecheck` script; `src/tests/fixtures.ts` (Team/Person + `ScriptedDataset` with mutations and a change feed); 15 hook tests. Dev wiring: core built and linked with `npm install --no-save ../core` (package.json untouched).
- Validation: `npm test` 4 suites / 50 tests; `npm run typecheck` exit 0.
- Deviation: subjects are bound as `{id}` references (a bare string goes through prefix resolution and rejects `urn:` ids); the same fix landed in core `keys.ts` (`84fd960`).

### Phase R1b — HOCs rebuilt (react) — completed
- Commit (react): `e6315cc`.
- Done: both factories on the hooks, contract preserved; `_refreshing`, `notFoundElement` (option, prop, default), `name`/`reactive` options; pinned templates at definition; `getLinkedComponentProps`/`isValidQResult` replaced by `hooks/of.ts`; six new behaviour cases.
- Validation: `npm test` 4 suites / 56 tests; typecheck exit 0.
- Deviation (core, `6afaae8`): a storage change (`setDefaultDataset` etc.) now resets the live cache — unwatched instances are dropped, watched ones refetch. Needed so cached rows from a previous dataset are never served; it also makes the existing behaviour suite pass unchanged.

### Phase R1c — reactivity end to end, context cleanup, docs, changeset (react) — completed
- Done: `src/tests/reactivity.test.tsx` (local mutation, dataset feed, `publishChange`, `invalidate`, echo folding, `reactive: false`, `useQueryContext` unmount), `useQueryContext` clears on unmount only when its value is still current, root/native exports (`useLinkedQuery`, `useLinkedSetQuery`, `withQuery`, re-exported `invalidate`/`publishChange`/`getLiveQueryStore`), README sections (Reactivity, Hooks, Subscribing outside React), changeset `major`, peer `@_linked/core` → `^2.25.0` (verify against the version core's changeset produces at wrapup).
- Validation: `npm test` 5 suites / 64 tests; typecheck exit 0; `npm run build` exit 0.
