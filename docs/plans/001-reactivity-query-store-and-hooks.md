---
summary: Active plan — automatic rerendering after mutations (reactivity) for @_linked/react via a query store with two-track (template + instance) dependency-matched invalidation, HOCs rebuilt on public hooks; one additive core minor (dispatch event + dependency helpers). Route 2 from docs/002-reactivity-and-hooks-routes.md, delivered in standalone phases.
status: Plan
packages: [react, core]
source: docs/002-reactivity-and-hooks-routes.md
---

# Reactivity: query store, invalidation, and hooks for `@_linked/react`

## 1. Goal and scope

Two components, one subject:

```tsx
const TeamMembers = linkedComponent(Team.select((t) => t.members.name), ({members}) => …);
const TeamHeader  = linkedComponent(Team.select((t) => [t.name, t.members.size()]), ({name, members}) => …);

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// → TeamHeader and TeamMembers refetch and rerender. A PersonCard for someone else does not.
```

Scope (phased, each phase independently shippable — see §9):

| Phase | Repo | Content | Release |
|---|---|---|---|
| 1 | react | `QueryStore` + internal hook; HOCs rebuilt on it at behaviour parity; rough edges fixed; `_refreshing`, `notFoundElement` | 1.7.0 |
| 2a | core | `subscribeQueryDispatch`, `queryDependencies`, `mutationEffects` (additive) | minor |
| 2b | react | observation, two-track matcher, `invalidate()`; peer floor → core 2a | 2.0.0 |
| 3 | react | public `useLinked`/`useLinkedSet`, `withQuery`, `prepareQueries`, query-context reactivity, README | 2.1.0 |
| 4 | react | opt-in optimistic patch layer | later |
| later | — | Suspense, SSR hydration, server push via the same change descriptor, devtools, store provider | — |

Out of scope unless the user pulls it in: local replica / normalized graph cache (ideation route 4), renames of the existing HOC prop contract (rejected in D5).

Ideation source and route comparison: [docs/002-reactivity-and-hooks-routes.md](../002-reactivity-and-hooks-routes.md). The accepted decisions D1–D10 are reproduced verbatim in §11 and are binding for this plan.

## 2. Architecture overview

```
                 ┌──────────────── @_linked/core ────────────────┐
 Shape.update()  │ builders ──► getQueryDispatch() ──► LinkedStorage ──► IDataset
                 │                     │ (instrumented by setQueryDispatch)
                 │                     ▼
                 │        subscribeQueryDispatch(listener)        lower(q) ──► queryDependencies(q)
                 │                                                             mutationEffects(m, result)
                 └──────────────────────┬────────────────────────────────────────┬──────┘
                                        │ {kind, query, result}                  │ watch sets / change sets
                 ┌──────────────── @_linked/react ──────────────────────────────▼──────┐
                 │  store/QueryStore (globalThis default; no React import)              │
                 │    templates (watch set, name)  ◄── keys.ts (template key + params)  │
                 │    instances (data, ids, status, subscribers)                        │
                 │    indexes: templatesByProp, templatesByShape, instancesById         │
                 │    matcher.ts: change ──► instances to refetch                        │
                 │  hooks/useLinked, useLinkedSet  (useSyncExternalStore)               │
                 │  utils/LinkedComponent: linkedComponent / linkedSetComponent (thin)  │
                 └──────────────────────────────────────────────────────────────────────┘
```

Data flow: a component (HOC or hook) resolves `template = templateFor(query)` and `params` from `of`/builder state; `store.subscribe(template, params, cb)` returns an instance; the instance fetches through `getQueryDispatch().selectQuery(boundQuery)` exactly as today. Every mutation anywhere in the app reaches the dispatch; core notifies the store; `mutationEffects` turns it into a change descriptor; the matcher selects instances; they refetch with data kept on screen; subscribers rerender.

## 3. Core changes (phase 2a) — additive, one minor

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

- `setQueryDispatch(d)` stores an **instrumented** copy: each of the five methods calls `d.<method>(query)`, captures the promise, notifies listeners synchronously with `{kind, query, result}`, and returns the same promise. Listeners never alter the promise; a throwing listener is caught and reported via `console.error`, never propagated to the caller.
- `resolveMutationDispatch(kind, target)` returns the same instrumentation around an explicit `target`, so `exec(target)` is observed too (closes ideation item 11).
- Listener set lives on the same `globalThis.__linkedQueryDispatch` record as the dispatch (single-instance rule, §8).
- Notification is on *call*, with the promise: the consumer decides whether to act before or after settlement. React acts after `result` resolves (D6 timing).
- Exported from `src/index.ts` beside `subscribeQueryContext`.

### 3.2 `queryDependencies` (new `src/queries/queryDependencies.ts`)

```ts
export type QueryDependencies = {
  /** Predicate IRIs the result values are read from (projection, nested sub-selects, preload sub-selects, aggregations, computed expressions). */
  projection: Set<string>;
  /** Predicate IRIs that decide membership/order: where, scoped relation where, minus, exists, sortBy, inner orderBy. */
  filter: Set<string>;
  /** Shape IRIs scanned or traversed: root scan, nested shape scans (`as()` casts, minus-by-shape), valueShape of every traversed property shape. */
  shapes: Set<string>;
  /** False when the query is bound to one or more subjects (`.for`, `.forAll`, resolved context). */
  unbound: boolean;
};
export function queryDependencies(query: LowerableSelect | LowerableCount | LowerableAsk): QueryDependencies;
```

Implementation: `lower(query)` then walk the IR.

- **Predicates, not property-shape ids.** IR `property` fields are property *shape* ids. The helper maps each to the predicate(s) it writes to disk: `pathExpr` on the node when present, else `findPropertyShapeById(id).path` → `getSimplePathId` or `collectPathUris` for structured paths. Matching on predicates is what makes `Employee.update({name})` hit a `Person.select(p => p.name)` instance (an override is a different property shape, same `sh:path`) and keeps `Team.name` and `Person.name` apart only when their paths differ. `findPropertyShapeById` moves from `sparql/irToAlgebra.ts` to `shapes/nodeShapeData.ts` (exported, cache kept) so both call sites share it.
- **Classification.** Start from `projection[].expression`: every `property_expr`/`aggregate_expr`/`function_expr` operand contributes its predicate to `projection`, and the traverse chain that produces its `sourceAlias` (walk `patterns` by `to` alias back to `root`) contributes each traversal's predicate to `projection`. Everything referenced from `where`, `orderBy`, `minus`/`exists` patterns, `traverse.filter`, `traverse.innerOrderBy`, `context_property_expr` goes to `filter`. A traverse in `patterns` reachable from neither is added to both (conservative). For `count`: `filter` only, plus shapes. For `ask`: `filter` only; a shapeless ask has empty sets and `shapes = ∅`.
- **Shapes.** `root.shape`, every `shape_scan` in `patterns`, and `findPropertyShapeById(p).valueShape.id` for every traversed property shape.
- `unbound = !(subjectId || subjectIds?.length)` on the lowered select/count.

### 3.3 `mutationEffects` (same file)

```ts
export type MutationEffects = {
  op: 'create' | 'update' | 'upsert' | 'delete';
  /** Target shape IRI of the mutation (routing shape). */
  shape: string;
  /** Predicate IRIs written, including nested node descriptions and `@add`/`@remove` relations. For delete: every predicate of the shape (informational; the matcher ignores props for deletes). */
  props: Set<string>;
  /** Node ids affected: targetId / ids, plus ids from `result` (created node, nested created nodes, `added`/`removed`/`updatedTo` rows). `undefined` = unknown (forAll / where / delete_all / delete_where). */
  ids?: Set<string>;
  /** Shapes whose membership may have changed: the target shape for create/upsert/delete, plus shapes of nested created nodes. Empty for a plain update. */
  membership: Set<string>;
};
export function mutationEffects(
  mutation: LowerableCreate | LowerableUpdate | LowerableDelete,
  result?: unknown,
): MutationEffects;
```

Implementation: `lower(mutation)`; walk `IRNodeData.fields` recursively (nested `IRNodeData`, `IRSetModificationValue.add[]`), mapping each `property` to predicates as in 3.2; collect ids from the IR (`id`, `ids[]`, nested `IRNodeData.id`) and from `result` (any `{id: string}` found while walking `result` recursively, which covers `CreateResult`, nested rows, `added`/`removed`/`updatedTo`). `MutationEffects` is the wire-neutral change descriptor a server push would also emit.

### 3.4 Tests and exports

- `src/tests/query-dispatch-subscribe.test.ts`: events for all five kinds; `exec(target)` observed; listener error isolation; re-`setDefaultDataset` keeps listeners.
- `src/tests/query-dependencies.test.ts`: table-driven over `Person`/`Dog` fixtures — simple projection, nested path, scoped where, outer where, sortBy, minus (shape/property/condition), `as()` cast, `size()`, computed expression, preloadFor sub-select, `selectAll`, inverse/structured `sh:path`, count, ask, bound vs unbound.
- `src/tests/mutation-effects.test.ts`: update literal, `@add`/`@remove`, nested create in update, create with nested nodes (+ result ids), upsert, delete ids/all/where, forAll/where updates (`ids` undefined).
- Exports: `subscribeQueryDispatch`, `QueryDispatchEvent`, `queryDependencies`, `mutationEffects`, `QueryDependencies`, `MutationEffects` from `src/index.ts`; README section "Observing queries and dependencies"; changeset `minor`.

## 4. React store (phase 1)

### 4.1 Data model (`src/store/`) — no React import

```ts
// keys.ts
export type InstanceParams = {
  subject?: string;            // resolved id for a single-subject instance
  subjects?: string[];         // forAll
  contextName?: string;        // pending/resolved query context the subject comes from (D7)
  limit?: number; offset?: number;
  vars?: Record<string, unknown>; // reserved for core query variables (D3)
};
export function templateKey(query: SelectBuilder): string;        // canonical toJSON() minus subject/subjects/limit/offset/one; WeakMap<SelectBuilder, string> memo
export function splitQuery(query: SelectBuilder): {templateJson: QueryBuilderJSON; params: InstanceParams};
export function paramsKey(p: InstanceParams): string;

// templates.ts
export type Template = {
  key: string;
  name?: string;
  json: QueryBuilderJSON;              // subject-less, for prepareQueries()/devtools
  builder: SelectBuilder;              // subject-less builder used to bind params at fetch time
  shapeIri: string;
  deps?: QueryDependencies;            // phase 2b; computed lazily (first instance) or by prepareQueries()
  reactive: boolean;                   // {reactive:false} opt-out (D6)
  instances: Map<string, Instance>;
};

// QueryStore.ts
export type InstanceStatus = 'pending' | 'loading' | 'success' | 'error';
export type Instance = {
  template: Template; params: InstanceParams; key: string;
  status: InstanceStatus;
  data?: unknown;                      // ResultRow | ResultRow[] | null
  error?: Error;
  notFound: boolean;                   // single-subject instance resolved to null
  seq: number;                         // last issued fetch sequence; responses with a lower seq are dropped
  refreshing: boolean;                 // fetch in flight while data is present
  staleWhileInflight: boolean;         // invalidated during a fetch → refetch once more on settle
  ids: Set<string>;                    // every `id` in the result tree + subject(s)
  subscribers: Set<() => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
};

export class QueryStore {
  template(query: SelectBuilder, opts?: {name?: string; reactive?: boolean}): Template;
  instance(template: Template, params: InstanceParams): Instance;   // get-or-create
  subscribe(instance: Instance, cb: () => void): () => void;         // first subscriber starts fetch if status==='pending'
  snapshot(instance: Instance): InstanceSnapshot;                    // stable object identity until state changes (useSyncExternalStore)
  refresh(instance: Instance): Promise<void>;                        // keeps data on screen; bumps seq
  patch(instance: Instance, partial: object): void;                  // local, immutable row copy, notify
  invalidate(target: ShapeConstructor | {id: string} | SelectBuilder | Template): void; // phase 2b
  templates(): ReadonlyArray<{key: string; name?: string; json: QueryBuilderJSON}>;      // for prepareQueries()
  reset(): void;                                                     // tests
}
export function getQueryStore(): QueryStore;   // globalThis.__linkedReactQueryStore ??= new QueryStore()
export function resetQueryStore(): void;
```

### 4.2 Behaviour

- **Fetch**: `template.builder` + params → `.for(subject)` / `.forAll(subjects)` / `.limit/.offset` → `getQueryDispatch().selectQuery(bound)`; pending context (`params.contextName` unresolved) → status `pending`, no request. `null` single result → `data = null, notFound = true` (the HOC keeps rendering with empty props by default, D5). Errors → `status 'error'`, previous data retained.
- **Structural sharing**: a refetch whose result deep-equals the current `data` keeps the old reference and does not notify.
- **Snapshot**: `{status, data, error, notFound, refreshing}` object recreated only on change; `useSyncExternalStore(subscribe, getSnapshot)` consumes it.
- **Lifecycle**: first subscriber triggers the fetch; last unsubscribe arms a GC timer (default 30 s) that deletes the instance, then the template if it has no instances and was not registered by a component definition.
- **Dedup**: two subscribers to the same template+params share one instance and one inflight request.
- **Rough edges fixed by construction** (ideation §3): storage-initialised check at fetch time; `of` identity churn no longer refetches (params key is value-based); `seq` guards out-of-order responses; no `console.warn` on re-entry.

### 4.3 Preloaded children

A HOC/hook whose `of` is a `QResult` containing every label of its template renders synchronously from that object and registers **no instance** (D5). It stays reactive through its parent's instance: the parent template's preload sub-select carries the child's predicates (3.2) and the parent's `ids` include the child row ids. Documented limitation: a QResult from a non-live source is static.

## 5. Hooks (phase 1 internal, phase 3 public) — `src/hooks/`

```ts
export type LinkedOptions = {enabled?: boolean; reactive?: boolean; name?: string};

export function useLinked<Q extends SelectBuilder>(query: Q, of?: OfInput, options?: LinkedOptions): {
  data: ResultOf<Q> | null | undefined; loading: boolean; refreshing: boolean; error?: Error;
  notFound: boolean; refresh: () => Promise<void>; patch: (p: Partial<ResultOf<Q>>) => void;
};
export function useLinkedSet<Q extends SelectBuilder>(query: Q, of?: SetOfInput, options?: LinkedOptions): {
  data: RowOf<Q>[] | undefined; loading: boolean; refreshing: boolean; error?: Error;
  refresh: () => Promise<void>; patch: (rows: RowOf<Q>[]) => void;
  page: {next(): void; previous(): void; set(i: number): void; setLimit(n: number): void; index: number; limit: number};
};
export function withQuery<C extends React.ComponentType<any>>(component: C, query: SelectBuilder): C & {query: SelectBuilder; shape: typeof Shape};
```

- `of` accepts `{id}`, a `Shape`, a `QResult`; for sets a `ShapeSet` or `QResult[]`; optional when the builder is already bound (`.for(id)` / `.for(getQueryContext('user'))`). `loading` = no data yet; `refreshing` = data present and fetch in flight.
- `enabled: false` → no instance, `loading: false, data: undefined`.
- Paging state (`limit`, `offset`) lives in the hook (`useState`) and feeds params; `page.setLimit` resets `index` to 0 as today.
- Internal `useInstance(template, params)` does `useSyncExternalStore`; phase 1 exports nothing new except via the HOCs; phase 3 exports `useLinked`, `useLinkedSet`, `withQuery`, `invalidate`, `prepareQueries`, `getQueryStore`, `resetQueryStore` from `src/index.ts` (and therefore `/native`, which re-exports the root).

## 6. HOCs rebuilt (phase 1) — `src/utils/LinkedComponent.ts`

Public contract preserved: factory overloads, `of` → `source`/`sources`, result keys as props, `_refresh()`/`_refresh(patch)`, `linkedData` and the `query` paging prop for sets, `loader`/`errorElement`/`'rethrow'` resolution chain, `LinkedComponentDefaults`, `.query`/`.shape`/`.original` statics, package registration, `LinkedComponentClass` untouched.

Additions: `_refreshing: boolean` injected; `notFoundElement?: React.ReactElement` option/prop resolved like `loader` (default: render component with empty result props, as today); template registered at definition time (`store.template(query, {name: options.name ?? functionalComponent.name, reactive: options.reactive})`); `reactive?: boolean` and `name?: string` in `LinkedComponentOptions`.

Behaviour changes (D5): data stays on screen during `_refresh()` and invalidation refetches; `of` change renders cached data when the store has that instance, else loader; cached instances are not revalidated on mount.

Sketch:

```tsx
const _wrapped = React.forwardRef((props, ref) => {
  const {loader, errorElement, notFoundElement, of, ...rest} = props;
  const source = getSourceFromInputProps(props, shapeClass);
  const preloaded = isValidQResult(of, template.builder) ? of : undefined;
  const r = useLinkedInternal(template, {subject: source?.id, contextName}, {enabled: !preloaded});
  if (!source && !template.builder.hasPendingContext() && !resolvedSubject) { warn; return null; }
  if (r.error) return resolveErrorElement(...);
  if (r.loading && !preloaded) return resolveLoader(...);
  if (r.notFound && resolveNotFound(...)) return notFoundEl;
  return React.createElement(fn, {...rest, source, ...(preloaded ?? r.data ?? {}), _refresh: refreshOrPatch, _refreshing: r.refreshing, ref});
});
```

## 7. Reactivity (phase 2b) — `src/store/matcher.ts`, `changes.ts`

- `QueryStore` constructor (or first `getQueryStore()`) subscribes once: `subscribeQueryDispatch(e => { if (e.kind is mutation) e.result.then(res => this.onChange(mutationEffects(e.query, res)), () => {}) })`. Failed mutations invalidate nothing.
- Templates compute `deps = queryDependencies(template.builder)` lazily on first instance (or in `prepareQueries()`); indexes updated on template registration and on every instance result (`instancesById`).
- `onChange(effects)` collects instances to refetch (D6):
  1. `effects.ids` known: for each id, `instancesById[id]`; keep instances whose `template.deps.projection ∪ filter` intersects `effects.props` — or **all** of them when `op === 'delete'`.
  2. For each template in `templatesByProp[p]` for `p ∈ effects.props` where `p ∈ template.deps.filter`: all its instances.
  3. `effects.ids` undefined (bulk): for each template in `templatesByProp[p]`, `p ∈ effects.props`: all instances.
  4. `effects.membership` non-empty (create/upsert/delete): for each template in `templatesByShape[s]` for `s` in the membership shapes expanded up and down the class hierarchy (`getShapeClass`, `hasSuperClass`): instances with `deps.unbound` (lists, counts, asks).
  5. Templates with `reactive: false` are skipped.
- Coalesce in a microtask per mutation; `refresh(instance)` on each; an instance with an inflight fetch sets `staleWhileInflight` and refetches once more on settle.
- `invalidate(target)`: `ShapeConstructor` → rule 4 with that shape plus every template whose `shapes` contain it; `{id}` → `instancesById[id]`; `SelectBuilder`/`Template` → all its instances.

## 8. Context reactivity, registry (phase 3)

- Store subscribes to `subscribeQueryContext(name => …)`: every instance whose `params.contextName === name` re-resolves `subject` via `getQueryContext(name).id`; new id → instance re-keyed (new instance, old one GC'd), fetch, notify; cleared → status `pending`, loader. `useQueryContext` clears on unmount only if the stored value is still the one it set.
- `prepareQueries(): Array<{key, name?, json}>` computes all template deps eagerly and returns the registry for database tuning / devtools.
- README: new "Reactivity" and "Hooks" sections; CHANGELOG via changesets.

## 9. Files expected to change

**core (phase 2a)**: `src/queries/queryDispatch.ts` (instrumentation + subscribe), `src/queries/queryDependencies.ts` (new), `src/shapes/nodeShapeData.ts` (+`findPropertyShapeById`), `src/sparql/irToAlgebra.ts` (import moved helper), `src/index.ts`, `src/tests/query-dispatch-subscribe.test.ts`, `src/tests/query-dependencies.test.ts`, `src/tests/mutation-effects.test.ts`, `README.md`, `.changeset/*.md`.

**react**: `src/store/{QueryStore,templates,matcher,changes,keys}.ts` (new), `src/hooks/{useLinked,useLinkedSet,useInstance,withQuery}.ts` (new), `src/utils/LinkedComponent.ts` (slimmed, rebuilt on hooks), `src/utils/useQueryContext.ts` (unmount clear), `src/index.ts`, `src/tests/fixtures.ts` (Person/Team/Dog shapes + `MockStore` with `updateQuery`/`createQuery`/`deleteQuery`), `src/tests/query-store.test.ts`, `src/tests/reactivity.test.tsx`, `src/tests/react-component-behavior.test.tsx` (kept; new cases for `_refreshing`, `notFoundElement`, cached `of` change), `package.json` (`typecheck` script; phase 2b peer/devDependency bump), `README.md`, `.changeset/*.md`.

## 10. Potential pitfalls

- **Predicate vs property-shape identity**: matching must use predicates on both sides (3.2). A test must cover an inherited/overridden property and a shared predicate across unrelated shapes.
- **Template key with `.for()` baked in**: `splitQuery` strips `subject/subjects/limit/offset/one` from `toJSON()` and keeps `builder` only for binding; the memo is per builder instance, so a HOC must register the template from the definition-time builder, never from the per-render `.for(source)`.
- **Pending context keys**: `toJSON().subject` is `{"@ctx": name}` while pending; params carry `contextName`, and the resolved id is read at fetch time.
- **Over-invalidation storms**: a bulk `forAll` update over a shape refetches every instance of templates touching those predicates; coalescing per mutation keeps it to one fetch per instance. Acceptable by D6.
- **Listener before storage**: `getQueryDispatch()` throws when unconfigured; the store subscribes to the listener set (independent of install) and only fetches when `LinkedStorage.isInitialised()`.
- **Hydration/SSR**: today's `typeof window` gate always renders the loader on the server; keep that behaviour in phase 1 (no SSR change in scope) but centralise it in the hook so a later SSR phase changes one place.
- **React 18 vs 19**: `useSyncExternalStore` exists in both; `forwardRef` remains for 18 compatibility.
- **GC and back-navigation**: 30 s grace period keeps recently unmounted instances; `reset()` in tests between cases.
- **Mock store in tests** must emit results through the real dispatch (`LinkedStorage.setDefaultDataset(mock)`) so the core event fires; phase 1 tests run without the event.

## 11. Decision log (from ideation; binding)

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
- **core** `docs/architecture/runtime-instances.md` — single module instance per runtime; critical process-wide state is `globalThis`-backed; only plain data crosses runtimes; never construct live `Shape` instances. **Compliance**: the dispatch listener set lives on `globalThis.__linkedQueryDispatch` next to the dispatch; the react store default lives on `globalThis.__linkedReactQueryStore` (D1); the store holds plain result rows and `{id}` params only; `Shape` instances are never created by the store (the HOC's existing `getSourceFromInputProps` behaviour is unchanged). The change descriptor (`MutationEffects`) is plain data so it can cross a serialization boundary for server push later.
- **core** `docs/architecture/publishing.md` — every published change needs a changeset; releases are dev → main gitflow. **Compliance**: phase 2a ships one `minor` changeset; react phases ship `minor`/`major`/`minor` changesets (D8). No publishing is performed without explicit consent.
- **core** `docs/architecture/ontologies.md` — not applicable.

Approved architecture extension: core gains an observation point on the dispatch and two IR-derived helper functions; no routing or lowering behaviour changes. Documented in core README under a new section (phase 2a).

## 13. Test strategy

| Package | Quick gate (after each phase, ~1–2 min target) | Full / slow (review) | Source |
|---|---|---|---|
| react | `npm test` (jest + jsdom + mock dataset, ~8 s) **plus** new `npm run typecheck` (`tsc -p tsconfig-test.json --noEmit`) | `npm run test:integration` (Docker Fuseki; also needs `../core/src/test-helpers`) — deferred: Docker not available in CI for this package, run locally in review | `package.json` scripts, `jest.config.cjs` |
| core (phase 2a only) | `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs --testPathPattern='query-dispatch-subscribe|query-dependencies|mutation-effects'` then `npm run typecheck` | `npm test` (full unit suite + typecheck, ~minutes), `npm run test:fuseki` (Docker) — deferred to review | `package.json` scripts |

Phase-specific validation: phase 1 → existing behaviour suite green unchanged + store unit tests + new HOC cases; phase 2a → the three new core suites + full core `npm test`; phase 2b → `reactivity.test.tsx` team scenario (header count updates after `members.add`, unrelated card untouched, filter-prop rename on a node outside the result refetches the filtered list, create refetches unbound list only, delete removes from lists) + matcher table tests; phase 3 → hook tests, context re-key test, `prepareQueries` registry test.

## 14. Remaining unclear areas

- Exact name of the HOC `name` option vs reusing `functionalComponent.name` (plan assumes `options.name ?? functionalComponent.name`).
- GC grace period default (plan assumes 30 s; trivially tunable).
- Whether `useLinked` should accept `CountBuilder`/`AskBuilder` in phase 3 or later (plan: later, noted in D4).
- Core version number for phase 2a is whatever changesets produce; react's phase 2b peer range becomes `^<that version>`.
