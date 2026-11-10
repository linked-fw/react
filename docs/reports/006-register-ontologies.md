---
date: 2026-11-10
summary: >
  `@_linked/react` compiles against the core that replaced `linkedOntology` with
  `registerOntologies` and dropped `ns` from its ontology module: the package object gives
  `registerOntologies`, and the component index declares the `core` namespace itself. Major.
packages: [react]
---

# 006 — `registerOntologies` in place of `linkedOntology`

## PR

**What changed.** The core this release builds on registers a package's ontologies with
`registerOntologies(ontologies, import.meta.url)` from a generated `ontologies/index`, registers no
prefix, and its `ontologies/linked-core` module holds only literal terms (no `ns`).

- `src/package.ts`: `linkedPackage(...)` and the package's own exports give `registerOntologies`
  in place of `linkedOntology` (the rest of core's package object is spread as before).
- `src/utils/componentIndex.ts`: the `core` prefix of `components.ttl` is a literal namespace
  (`https://linked.cm/ont/core/`) next to the `xsd` one, instead of `ns('')` from core's ontology
  module. The file is self-contained and declares its own prefixes, so it does not depend on the
  app's prefix map; its bytes are unchanged.

Major changeset (`.changeset/register-ontologies.md`): `linkedOntology` leaves the public exports.

**Verification**

`npx linked build`:

```
✔ Writing components.ttl
✔ Checking sideEffects
✔ Checking dependencies
✔ Build successful
```

`npm test`:

```
Test Suites: 7 passed, 7 total
Tests:       84 passed, 84 total
```

`npm run typecheck` (`tsc -p tsconfig-test.json --noEmit`): exit 0, no output.
`component-index.test.tsx` asserts the prefix line `@prefix core: <https://linked.cm/ont/core/> .`.

**Deviations.** None.

**Follow-ups.** None in this repo. Raising the `@_linked/core` range to the new major happens at
release, with every package of the coordinated major.

## Details

### Phases

1. Inventory: a grep of `src` for the removed core API (`linkedOntology`, `ns` from ontology
   modules, `Prefix.add`, `toFullIfPossible`, `resolvePrefixedUri`) and for prefixed strings that
   rely on a globally registered prefix. Two hits, both fixed; no prefixed strings.
2. Fix, build, test, typecheck (above).

### Decisions

| # | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|
| 1 | `components.ttl` needs the core namespace; core's module no longer exports `ns` | a literal, like the `xsd` one beside it | `createNameSpace` or reading the registry | the file's prefix section is fixed text; a literal states it directly |
| 2 | changeset level | major | minor | `linkedOntology` is removed from the exports |
