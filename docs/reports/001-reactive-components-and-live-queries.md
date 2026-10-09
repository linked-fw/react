---
summary: Reactive data-bound components for @_linked/react 2.0 — linkedComponent / linkedSetComponent rebuilt on @_linked/core's new live-query store, so every mounted component whose query can have read changed data (local mutation, dataset change feed, or app-published change) refetches and rerenders, and nothing else does; plus public hooks (useLinkedQuery, useLinkedSetQuery). Cross-repository record of the ideation, decisions, implementation and review iteration.
packages: [react, core]
---

# Reactive components and live queries

Core-side report: `@_linked/core` `docs/reports/031-live-queries.md`. User documentation: this package's README ("Reactivity", "Hooks", "Subscribing outside React") and core's [live-queries guide](https://github.com/linked-fw/core/blob/main/documentation/live-queries.md). Release notes: `.changeset/reactive-components.md` (react, major) and core `.changeset/live-queries.md` (minor).

## Problem and outcome

Two components showing one team — a member list and a header with the member count — did not update when a member was added elsewhere: every wrapper held its own state, fetched once, and only `_refresh()` or a parent rerender could change it. Now:

```tsx
const TeamMembers = linkedComponent(Team.select((t) => t.members.name), ({members}) => …);
const TeamHeader  = linkedComponent(Team.select((t) => [t.name, t.members.size()]), ({name, members}) => …);

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// TeamHeader and TeamMembers refetch and rerender; a PersonCard for someone else does not.
```

The same works for changes made elsewhere (a dataset's change feed, or `publishChange` from the app's own transport) and outside React (`query.live()` in core).

## Route and decisions

Route chosen in ideation (of four): a **query store with automatic, dependency-matched invalidation, components rebuilt on a hook**. Rejected: a per-component invalidation bus (no cache, refetch storms), explicit invalidation only (the automatic part was the goal), a client-side replica graph (needs partial-data semantics core lacks; may slot in later underneath the store).

Decisions (ideation D1–D10, with the plan-review amendments):

- **Store location (D1, amended):** in core (`src/live/`), registered on `globalThis` like the dispatch and routing table, so subscriptions work outside React and change sources are core concerns. A per-subtree React provider override stays possible later.
- **Observation (D2):** core `subscribeQueryDispatch` — the dispatch installed by `setQueryDispatch` is instrumented; `exec(target)` is too. No wrapper, no install ordering.
- **Identity (D3):** two tracks. Template = subject-less query (watch set, registry for database tuning); instance = template + params (subject, subjects, context, limit, offset) with data and ids.
- **Hooks (D4, amended):** `useLinkedQuery(query, of?, options?)` and `useLinkedSetQuery(query, of?, options?)`, names parallel to the components and clear of React Query's `useQuery`; no public `useLiveQuery` (counts and asks go through `useLinkedQuery`). Core's single entry point is `.live()`, whose handle has `subscribe(cb)` (Svelte contract), is thenable for the first data and accepts a listener directly.
- **Component contract (D5):** unchanged public contract; stale-while-revalidate; additive `_refreshing`, `notFoundElement`, `name`, `reactive`; no prop renames (they were rejected as cosmetic churn across dependents).
- **Matching (D6):** index-driven with conservative fallbacks; predicate identity; shape scoping; `hidden` dependencies (see core report).
- **Context reactivity (D7):** store-level subscription to `subscribeQueryContext`; `useQueryContext` clears on unmount only when its value is still current.
- **Releases (D8):** one core minor; react 2.0.0 because the core peer floor rises.
- **Dependency extraction (D9):** in core, from the IR (`queryDependencies`, `mutationEffects`), not re-parsed from DSL-JSON.
- **Layout (D10):** core `src/live/`; react `src/hooks/` plus the slimmed component file.
- **No `withQuery` (decided at wrapup):** an earlier draft exported `withQuery(Component, query)` to give hook-based components the static `query`/`shape` and registration of a linked component. It was removed before release: it attached a contract nothing enforced (the component need not take `of` or use that query), it did not register in the package export tree, and it overlapped with `linkedComponent`. Linked components are the discoverable, connectable unit — the one tooling such as a visual builder lists and describes (component, accepted shape, query) — while hooks are data access for components that need not be discovered.

## React package: what changed

### Files

| File | Responsibility |
|---|---|
| `src/hooks/of.ts` | `OfInput`/`SetOfInput`, `subjectIdOf`, `subjectIdsOf`, `isCompleteQResult` (own properties only; Shape instances are never treated as data), `ownPropsOf`. |
| `src/hooks/useLiveQuery.ts` | Internal `useSyncExternalStore` over a core `LiveQuery` handle; imports the core store module so deep-path consumers get it registered; SSR snapshot is idle. |
| `src/hooks/useLinkedQuery.ts` | Public single-subject hook; internal `useLive` (one handle per instance key, closed on change/unmount; StrictMode-safe because handles are reopenable), `usePreloadedState` (local patch / go-live state keyed by subject), `useStableContextQuery` (keeps a context-bound inline builder stable on the render where the context lands). |
| `src/hooks/useLinkedSetQuery.ts` | Public list hook with paging state; empty subject set → `[]` without fetching; complete result arrays are paged client-side. |
| `src/utils/LinkedComponent.ts` | Both factories rebuilt on the hooks; pinned templates registered at definition; `notFoundElement` resolution; types kept. |
| `src/utils/useQueryContext.ts` | Set on id change, clear on unmount only if still current. |
| `src/index.ts` | Named exports of the hooks and their types; re-exports `invalidate`, `publishChange`, `getLiveQueryStore` and the live types from core. `/native` re-exports the root. |
| `package.json` | `typecheck` script; peer `@_linked/core` `^2.27.0`. |

### Public API

```ts
useLinkedQuery(query, of?, {enabled?, reactive?, name?})
  → {data, loading, refreshing, error, notFound, refresh, patch}
useLinkedSetQuery(query, of?, options?)
  → {data, loading, refreshing, error, refresh, patch, page: {next, previous, set, setLimit, index, limit}}
// components: `_refreshing` prop; options/props `notFoundElement`; options `name`, `reactive`
```

`loading` means no data yet; `refreshing` means data is present and a fetch is in flight. `of` is `{id}`, a Shape or a result object (sets: ShapeSet or an array) and is optional for a bound builder, a count or an ask. Use the components by default (they carry the static `query` that `preloadFor` and the registry discover); use a hook for several queries per component, state-dependent queries, conditional fetching, inline counts, or data without an `of` subject. Reactivity does not depend on the choice: hooks and components both register live instances. What only a linked component adds is discovery without rendering — `preloadFor`, the package registry, and a pinned template in `templates()`/`prepare()`; a bare hook's template exists only while mounted.

### Behaviour changes worth knowing

- Data stays rendered during refetches; a cached subject renders immediately on an `of` change; identical queries share one request.
- `_refresh(patch)` edits the shared cached result (every component on the same query and subject sees it until the next refetch). On a preloaded child the edit stays local and `_refresh()` makes the child fetch on its own; both reset when the subject changes.
- `reactive` and `name` apply to the query template.
- The set component's `query.setLimit()` returns to the first page.
- Fixed along the way: a set component defined before storage never loaded; a fresh `ShapeSet` per parent render refetched every render; a fast `of` change could render an older response; a component bound to a pending context did not update when it landed; a Shape instance as `of` was mistaken for preloaded data; a component mounted before storage stayed empty; `useQueryContext` with an inline value re-set the context on every render.

### Worked matching examples

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

## Implementation history

Core phases (commits on `linked-fw/core`, branch `claude/react-library-reactivity-gtgczr`): C1a dispatch observation `a56f01a`; C1b dependency helpers `ce87509`; C2a store and `.live()` `63534cf`; C2b change sources and matcher `8180076`; C3 docs `f397a2e`; follow-ups `84fd960` (bind `{id}` references), `6afaae8`/`96dd1f4` (storage change resets the cache); review iteration `5176c64`.

React phases (this repository): R1a hooks `7a3143b`; R1b components `e6315cc`; R1c reactivity, exports, docs `9277fe4`; review iteration `c8c031a`.

Deviations recorded during implementation: subjects are bound as `{id}` references (bare strings go through prefix resolution and reject `urn:` ids); shape scoping was added to the matcher after the first matching run showed the hand-written expectations had missed shared-predicate consequences (the tables above are the implemented behaviour); a storage change resets the cache.

### Review and iteration 1

Two independent reviews (core store, react layer) found, among others: a StrictMode crash; `unbound` and `limit`/`one` leaking between instances of one template; value-blind echo folding dropping a second write within 50 ms; handles orphaned after GC; Shape instances in `of` never fetched; `useQueryContext` refetching on every render; components mounted before storage never healing; empty subject sets fetching everything; unset where-contexts throwing; `exec(target)` ignoring the target's `authoritativeChanges`; feeds of removed datasets never unsubscribed; missing error isolation. All medium-and-higher findings were fixed in the iteration commits above, each with a regression test.

## Tests

| File | Covers |
|---|---|
| `src/tests/hooks.test.tsx` | Subject, bound builder, count, preloaded (no fetch), `enabled`, notFound, cached `of` switch without refetch, refreshing, pending context, GC after unmount, list paging and page size, ShapeSet/array narrowing, stable ShapeSet, client-side paging. |
| `src/tests/react-component-behavior.test.tsx` | The original component suite unchanged, plus `_refreshing`, `notFoundElement` (option, prop, default), set component defined before storage, stable ShapeSet, out-of-order responses, pending context. |
| `src/tests/reactivity.test.tsx` | The team scenario end to end: member add, rename, unrelated card, remote feed, `publishChange`, `invalidate`, echo folding, `reactive:false`, `useQueryContext` cleanup; review regressions (StrictMode, Shape `of`, inline `useQueryContext`, mount before storage, empty set). |
| `src/tests/native-barrel.test.tsx`, `classnames-and-query-context.test.tsx` | Native entry exports and defaults; utilities. |
| `src/tests/fixtures.ts` | Team/Person model with a shared `schema:name`, a scripted dataset with mutations and a change feed. |

Final validation: `npm test` 5 suites / 69 tests; `npm run typecheck` clean; `npm run build` clean. The Fuseki integration suite (`npm run test:integration`) needs Docker and was not run here. One cosmetic `act()` warning remains in the test output.

## Release and merge order

1. Merge and publish the core PR (minor; published as 2.27.0).
2. In this PR, bump the `@_linked/core` devDependency to the published version and refresh the lockfile — until then CI installs core 2.22.8, which has no live queries, and the suites fail. Development here used `npm install --no-save ../core`.
3. Merge this PR (major, 2.0.0).

## Known limitations and follow-ups

- `.for(getQueryContext())` changes from a context reference to a plain subject once the context is set (core wire behaviour, asserted by a core test); the hook compensates.
- `reactive` is per template, not per component.
- No Suspense mode, SSR hydration, `refetchOnMount`, store provider override or optimistic local patching of mutations yet; none were in scope.
- Small cleanups: one `act()` warning; type helpers could be consolidated.
