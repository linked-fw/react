---
"@_linked/react": patch
---

`linkedSetComponent` with a record of queries (`linkedSetComponent({people: Person.select(...)}, ({people}) => ...)`) types each key as the query's result rows again under `@_linked/core` 2.39, where a `QueryBuilder` is no longer structurally a `FieldSet` and the key was typed `never`. Tested against `@_linked/core` 2.39.3.
