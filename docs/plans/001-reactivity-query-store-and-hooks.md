---
summary: Active plan — live queries for Linked. Core gains a framework-free live-query store (two-track templates + instances, dependency-matched invalidation) fed by local mutations, optional dataset change feeds and app-published changes, with `query.subscribe()` usable anywhere; @_linked/react 2.0 rebuilds its HOCs on it and exposes hooks. Route 2 from docs/002-reactivity-and-hooks-routes.md, revised 2026-10-05 to cover subscriptions outside React and remote changes.
status: Plan
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

Given `e: MutationEffects` and a template `T` with `deps`:

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
| `Person.update({name}).for(P1)` | props name; ids P1 | M (1), L (2: sortBy name) | H untouched: T1 only, name is narrow in H |
| `Person.update({email}).for(P9)` | props email; ids P9 | C | |
| `Team.update({lead: P2}).for(T1)` | props lead; ids T1,P2 | F (2) | |
| `Person.create({name, age: 30})` | membership Person; ids Pnew | L (4) | M, C, H bound → untouched |
| `Person.delete(P1)` | membership Person; ids P1 | M (ids), L (unbound), H (bound, shapes ∋ Person) | |
| `Employee.update({name}).for(E1)`, E1 ∈ L | props schema:name; ids E1 | L (2), M if E1 member (1) | predicate identity |
| `Team.create({name})` | membership Team | N (4) | |

Defensive refetches:

| Mutation | refetch | why |
|---|---|---|
| `Person.update({age: 17}).for(P5)`, P5 ∉ L page | L | filter predicate; membership may change (rule 2) |
| `Person.update({name}).forAll()` | H, M, L, C, U | ids unknown (rule 3); H over-refetches via shared `schema:name` — shape narrowing for bulk mutations is a later refinement |
| `Team.update({members:{add:[{name:'New'}]}}).for(T1)` | H, M, L | nested create → membership Person → L (rule 4) |
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
| `Team.update({name}).for(T1)` | N, L | count has no reads; L is over Person |
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
