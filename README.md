# @_linked/react

React bindings for `@_linked/core`.

`@_linked/react` takes a Linked query from `@_linked/core`'s [Schema-Parameterized Query DSL](../core/README.md#schema-parameterized-query-dsl) and maps the top-level query result keys to props for a React component.

> **Query API note.** Queries are built with `Shape.select(...)` which returns a `QueryBuilder`. A `QueryBuilder` is **lazy** — it only fires when you `await` it or pass it through `linkedComponent` / `linkedSetComponent`. The old `Shape.query(...)` builder name is gone; use `.select(...)` everywhere.

This package provides:
- `linkedComponent(...)`
- `linkedSetComponent(...)`
- `LinkedComponentClass`
- `useStyles(...)`

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
- Custom props: any additional props you pass to the linked component are forwarded as normal.

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

## Data-bearing component boundary

A public component whose primary content comes from graph facts uses `linkedComponent` or
`linkedSetComponent`, a canonical `Shape.select(...)`, and an `of={...}` subject binding. The query
result is the data authority.

Additional parent props are for callbacks, slots/renderers, route or display state, and host
context. They must not carry a second canonical record or replace graph facts already selected by
the component.

```tsx
const CoveragePanel = linkedSetComponent(
  AssignmentShape.select((assignment) => [
    assignment.assignee,
    assignment.intervalStart,
    assignment.intervalEnd,
  ]),
  ({linkedData, renderEmpty}) =>
    linkedData.length
      ? <CoverageRows assignments={linkedData} />
      : renderEmpty(),
);

<CoveragePanel
  of={{id: scheduleId}}
  renderEmpty={() => <EmptyCoverage />}
/>;
```

### Semantic variables and host overrides

Reusable components express semantic state through a component/package variable, then a LINKED
semantic variable, then a stable surface fallback:

```css
.gap {
  background: var(
    --schedule-coverage-gap-background,
    var(--linked-warning-background, var(--linked-surface-raised))
  );
}
```

Do not encode semantic state with a raw brand color. A host changes the first variable at its theme
or container scope. Contextual slots and render callbacks are the markup override seam; neither
override path creates another data authority.

## Render lifecycle and loading state

When `LinkedStorage` is initialized and data is not already preloaded in `of`:
- First render: returns a loading element.
- Query resolves: component rerenders with mapped query result props.
- Source changes (`of` changes): prior query result is cleared and query runs again.

Loading fallback is currently fixed to:

```html
<div class="ld-loader" role="status" aria-label="Loading"></div>
```

There is no API prop to replace this element today. You can style it via CSS class `.ld-loader`.

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

- This package depends on `@_linked/core` query APIs and `preloadFor(...)` / `BoundComponent` behavior from core.
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
- Make loader configurable and/or switch to passing a loading-state prop.

## Development

```bash
npm run build
npm test
```

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
