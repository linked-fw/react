---
"@_linked/react": minor
---

Component index: `componentIndexTurtle(packageName, exports)` and `componentIndexEntries` in `@_linked/react/utils/componentIndex` turn the linked components a package exports from `components/index` into the Turtle `linked build` writes as `lib/esm/data/components.ttl` (export name, start shape, query shape, query wire format as canonical `rdf:JSON`). `linkedSetComponent` marks its result `setComponent: true`. Needs `@_linked/core` 2.46 (peer range raised).
