# @_linked/react

React bindings for `@_linked/core`.

`@_linked/react` takes a Linked query from `@_linked/core`'s [Schema-Parameterized Query DSL](../core/README.md#schema-parameterized-query-dsl) and maps the top-level query result keys to props for a React component.

> **Query API note.** Queries are built with `Shape.select(...)` which returns a `QueryBuilder`. A `QueryBuilder` is **lazy** — it only fires when you `await` it or pass it through `linkedComponent` / `linkedSetComponent`. The old `Shape.query(...)` builder name is gone; use `.select(...)` everywhere.

This package provides:
- `linkedComponent(...)` and `linkedSetComponent(...)` — reactive, data-bound components
- `useLinkedQuery(...)`, `useLinkedSetQuery(...)` and `withQuery(...)` — the hooks underneath them
- `LinkedComponentClass`
- `useStyles(...)`, `useQueryContext(...)`

Components and hooks are **reactive**: after any mutation — local, reported by a dataset's change feed, or published by your code — every mounted component whose query can have read the changed data refetches and rerenders, and nothing else does. See [Reactivity](#reactivity).

## Install

```bash
npm install @_linked/react @_linked/core react react-dom
```

Supports React 18 (`^18.2.0`) and React 19 (`^19.0.0`).

## React Native

Import from the `@_linked/react/native` subpath instead of the root:

```tsx
import {linkedComponent, linkedSetComponent, linkedShape} from '@_linked/react/native';
```

It exports the same API as `@_linked/react` (the same objects, not copies). Importing it also sets React Native render defaults, because the built-in loader and error elements are `<svg>` elements, and those crash on React Native:

- `LinkedComponentDefaults.loader`: `<ActivityIndicator testID="linked-loader" />`
- `LinkedComponentDefaults.errorElement`: `<Text testID="linked-error" accessibilityRole="alert">Failed to load</Text>`
- `LinkedInfinityLoader` renders the same `ActivityIndicator`

It sets a default only when your app hasn't already set it. Instance props and definition options still take precedence as usual. Use the subpath for at least the first `@_linked/react` import your app evaluates, for example in `App.tsx`.

`react-native` (`>=0.76`) is an optional peer dependency. The root entry never imports it, so web apps don't install it and get no peer warning.

## Usage

### Setup package exports

```tsx
import {
  linkedComponent,
  linkedSetComponent,
  linkedShape,
} from '@_linked/react';
```

### `linkedComponent(...)`

`linkedComponent(...)` wraps a React component with a Linked query. You pass a query built with `Shape.select(...)` — the returned `QueryBuilder` is lazy and the wrapper fires it at render time. When you pass `of={{id: ...}}`, the wrapper applies the prepared query to that subject and injects the query result keys as props into your component.

```tsx
const PersonCard = linkedComponent(
  Person.select((p) => p.name),
  ({name, source, _refresh}) => (
    <article>
      <h3>{name}</h3>
      <small>{source.id}</small>
      <button onClick={() => _refresh()}>Reload</button>
    </article>
  ),
);

// External API: pass `of` as a node reference (`{id: string}`), Shape, or QResult.
<PersonCard of={{id: 'https://example.org/p1'}} />;
```

Props received by the wrapped component:
- Query result props: all top-level keys from the query result become direct props (for example `name`).
- `source`: the resolved shape instance for the input `of` subject.
- `_refresh(updatedProps?)`: rerun the query (`_refresh()`) or patch local query-result props before rerender (`_refresh({...})`).
- `_refreshing`: `true` while a refetch is in flight and the current data is still rendered.
- Custom props: any additional props you pass to the linked component are forwarded as normal.

Definition options (third argument, or keys of the config object): `loader`, `errorElement`, `notFoundElement` (rendered when a single-subject query answers `null`; without it the component renders with empty result props), `name` (registry name of the query template, defaults to the component's function name) and `reactive` (`false` opts the component out of automatic refetching). `loader`, `errorElement` and `notFoundElement` can also be passed per instance, and app-wide through `LinkedComponentDefaults`.

#### `_refresh(updatedProps?)` on linked components

`_refresh` is injected into wrapped `linkedComponent(...)` render functions.

- `_refresh()` reruns the query and rerenders when results return.
- `_refresh(updatedProps)` merges `updatedProps` into current query result state and rerenders immediately (without fetching first).
- `updatedProps` is for query result keys only (for example `name`, `active` from your query), not regular additional props passed by parents.

Example use case: optimistic UI after a mutation.

```tsx
const PersonCard = linkedComponent(
  Person.select((p) => [p.name, p.active]),
  ({id, name, active, _refresh, title}) => (
    <div>
      <h4>{title}</h4>
      <span>{name}</span>
      <button
        onClick={async () => {
          // Patch query-result keys immediately (name/active/id/etc.)
          _refresh({active: !active}); // optimistic local query-result update
          await saveActiveFlag(id, !active); // your write call
          _refresh(); // optional: sync with store response
          // Not for parent custom props like `title`; those come from parent rerender.
        }}
      >
        Toggle active
      </button>
    </div>
  ),
);
```

### `linkedSetComponent(...)`

Use `linkedSetComponent(...)` when you want to render a list of sources.

### `linkedSetComponent(...)` (direct query format)

```tsx
const NameList = linkedSetComponent(
  Person.select((p) => p.name),
  ({linkedData}) => (
    <ul>
      {(linkedData || []).map((person) => (
        <li key={person.id}>{person.name}</li>
      ))}
    </ul>
  ),
);
```

### `linkedSetComponent(...)` (named data-prop format)

```tsx
const personQuery = Person.select((p) => [p.name, p.hobby]);

const NameList = linkedSetComponent({persons: personQuery}, ({persons}) => (
  <ul>
    {persons.map((person) => (
      <li key={person.id}>{person.name}</li>
    ))}
  </ul>
));
```

Both formats are supported. For linked-set wrappers, the external API is also `of` (optional). Internally this becomes `sources` for the wrapped component.

## Render lifecycle and loading state

When `LinkedStorage` is initialized and data is not already preloaded in `of`:
- First render: returns the loading element (built-in SVG `.ld-loader`, or `loader` from the instance, the definition options or `LinkedComponentDefaults`).
- Query resolves: component rerenders with mapped query result props.
- A refetch (`_refresh()`, or an automatic one after a change): the current data stays rendered and `_refreshing` is `true` until the response lands.
- `of` changes: if that subject is already cached in the live-query store it renders immediately, otherwise the loading element shows until it loads.
- Identical queries share one request and one cached result, across components.

## Reactivity

Two components, one subject:

```tsx
const TeamMembers = linkedComponent(Team.select((t) => t.members.name), ({members}) => (
  <ul>{members.map((m) => <li key={m.id}>{m.name}</li>)}</ul>
));
const TeamHeader = linkedComponent(Team.select((t) => [t.name, t.members.size()]), ({name, members}) => (
  <h2>{name} ({members})</h2>
));

await Team.update({members: {add: [{id: personId}]}}).for({id: teamId});
// → TeamHeader and TeamMembers refetch and rerender. A PersonCard for someone else does not.
```

How it works: core keeps a live-query store (see core's [live-queries guide](../core/documentation/live-queries.md)). Every mounted component is a live instance of its query template; the template's dependencies — which predicates it reads, which it filters or sorts on, which shapes it touches — are computed once from the query. Every change is normalised to what it wrote and which nodes it touched, and the store refetches exactly the instances that can have been affected, by node id where it can tell and template-wide where it cannot.

Change sources, all automatic once set up:
- **Local mutations** — every `await Shape.update/create/delete(...)` in the app, `exec(target)` included.
- **A dataset's change feed** — a dataset that implements `IDataset.subscribeChanges(listener)` reports changes made elsewhere (another client, a server job) as the mutation's DSL-JSON plus its result, or as precomputed effects.
- **Your own transport** — `publishChange({mutation, result})` or `publishChange({effects})` from application code (re-exported from `@_linked/react`).
- **Manual** — `invalidate(Team)`, `invalidate({id})`, `invalidate(query)` or `_refresh()`.

A component can opt out with `{reactive: false}`. A result object passed through `of` by a parent that preloaded it (`preloadFor`) does not subscribe on its own; it stays fresh through the parent, whose query includes the child's fields.

## Hooks

The components are built on two hooks, exported for the cases the component shape does not fit: several queries in one component, a query that depends on local state (a search box, a selected tab), conditional fetching, an inline count, or data with no `of` subject.

```tsx
import {useLinkedQuery, useLinkedSetQuery, withQuery} from '@_linked/react';

function TeamPage({teamId}: {teamId: string}) {
  const team = useLinkedQuery(Team.select((t) => [t.name, t.members.size()]), {id: teamId});
  const total = useLinkedQuery(Team.select().toCount());
  const [q, setQ] = useState('');
  const results = useLinkedSetQuery(
    Person.select((p) => p.name).where((p) => p.name.contains(q)).limit(20),
    undefined,
    {enabled: q.length > 1},
  );
  if (team.loading) return <Spinner />;
  // team.data.name, team.data.members, team.refreshing, team.notFound, team.refresh(), team.patch({...})
  // results.data, results.page.next() / previous() / set(i) / setLimit(n)
}
```

- `useLinkedQuery(query, of?, options?)` → `{data, loading, refreshing, error, notFound, refresh, patch}`. `of` is `{id}`, a Shape, or a result object; optional when the builder is already bound (`.for(id)`, `.for(getQueryContext('user'))`) or is a count/ask. `loading` means no data yet; `refreshing` means data is present and a fetch is in flight.
- `useLinkedSetQuery(query, of?, options?)` → the same plus `page: {next, previous, set, setLimit, index, limit}`. `of` is a `ShapeSet` or an array of `{id}`/Shapes/result objects.
- Options: `enabled` (default `true`), `reactive`, `name`.
- `withQuery(Component, query)` sets `Component.query`/`Component.shape`, registers the component and pins its template, so a parent can `preloadFor(Component)` exactly as with a linked component.

Use the components by default — they carry the static `query` that `preloadFor` and the package registry discover — and reach for a hook when you need the flexibility.

## Subscribing outside React

The same store works without React: `query.live()` returns a handle with `state`, `subscribe(cb)`, `refresh()`, `patch()` and `close()`, and `await live` resolves with the first result. See core's [live-queries guide](../core/documentation/live-queries.md).

## Linked set pagination API

When `linkedSetComponent(...)` has a limit (explicit query limit or default limit), wrapped props include:
- `query.nextPage()`
- `query.previousPage()`
- `query.setPage(pageIndex)`
- `query.setLimit(limit)`

There is no public `setOffset(...)` in the React query controller; use `setPage`, `nextPage`, or `previousPage`.

Example:

```tsx
import React from 'react';

const PeopleList = linkedSetComponent(
  Person.select((p) => [p.name]).limit(5),
  ({linkedData = [], query}) => {
    const [page, setPage] = React.useState(0);

    return (
      <section>
        <ul>
          {linkedData.map((person) => (
            <li key={person.id}>{person.name}</li>
          ))}
        </ul>

        <div>
          <button
            onClick={() => {
              query?.previousPage();
              setPage((p) => Math.max(0, p - 1));
            }}
          >
            Previous
          </button>

          <span>Page {page + 1}</span>

          <button
            onClick={() => {
              query?.nextPage();
              setPage((p) => p + 1);
            }}
          >
            Next
          </button>

          <label>
            Page size
            <select
              defaultValue="5"
              onChange={(e) => {
                const nextLimit = Number(e.target.value);
                query?.setLimit(nextLimit);
                query?.setPage(0);
                setPage(0);
              }}
            >
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="25">25</option>
            </select>
          </label>
        </div>
      </section>
    );
  },
);
```

## Notes

- This package depends on `@_linked/core` query APIs, its live-query store, and `preloadFor(...)` / `BoundComponent` behavior from core.
- `@_linked/react` itself does not provide RDF storage; use a store package and set a default store in `LinkedStorage` (for example `@_linked/rdf-mem-store`).

## Storage setup (example: `@_linked/rdf-mem-store`)

For local in-memory setup, register `@_linked/rdf-mem-store` as the default store:

```tsx
import {LinkedStorage} from '@_linked/core';
import {InMemoryStore} from '@_linked/rdf-mem-store';

LinkedStorage.setDefaultStore(new InMemoryStore());
```

## TODO

- Add `setOffset` to `linkedSetComponent` query controller.

## Development

```bash
npm run build
npm test
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
