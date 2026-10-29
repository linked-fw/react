---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/react`: the
  react half of step CI — `componentIndexTurtle`, which turns a package's `components/index`
  exports into the component index Turtle (K8) that `linked build` writes as
  `lib/esm/data/components.ttl`, plus a set-component marker. Lands on the master `hub-imports`.
status: Plan
---

# 001 — Hub imports: react steps

## Master plan

[CN plan 282](../../../../docs/plans/282-shapes-and-packages-per-hub.md) —
`/Users/rene/web/wt/hub-imports/docs/plans/282-shapes-and-packages-per-hub.md` (decisions D5,
D13, D15, D24, G5; rules for every step; status table; numbers). The step's full section (all
three repos, Verify, tests, phases) is in
[cli plan 004 §CI](../../../_linked-cli/docs/plans/004-hub-imports-cli.md). Steps land on the
master branch `hub-imports` in this worktree
(`/Users/rene/web/wt/hub-imports/packages-local/_linked-react`) with
`git merge --ff-only hub-imports--<agent>`; never on `dev` or `main` directly.

## Contracts

K8 is copied verbatim from cli plan 004 (where it was settled at wave 2). A step that changes it
updates it there, here and in 282 in the same landing.

- **K8 Component index file** (provider CI: the generator in `@_linked/react`, the build step in
  `_linked-cli`, the terms in `@_linked/core`'s ontology; consumer CX). Settled at wave 2 (was
  *open*); copied verbatim into react plan 001 and, once the master accepts it, into 282.
  - **Enumeration.** A package offers components through `src/components/index.ts`
    (`lib/esm/components/index.js`): its named exports. Every export that is a linked component
    (made by `linkedComponent`/`linkedSetComponent`: carries `.query` and `.shape`) is indexed;
    other exports are ignored. No `components/index`, no file. A component exported under several
    names is one entry, named by the code-point-smallest of them.
  - **File.** `lib/esm/data/components.ttl`, written by the build step `Writing components.ttl`
    (right after `Writing shapes.ttl`) in a child `node` that imports `lib/esm/package.js` (when
    present), `lib/esm/shapes/index.js` (when present) and `lib/esm/components/index.js`, with
    asset hooks, then calls `componentIndexTurtle(packageName, componentsModule)` from
    `@_linked/react/utils/componentIndex` of the `@_linked/react` the package resolves.
    `packageName` is the name in `linkedPackage('<name>')` (else `package.json`'s), as for
    `shapes.ttl`. No linked component, no file; a file from an earlier build is removed whenever
    none is written. A react without `utils/componentIndex`: skipped with a warning. A module that
    throws on import fails the build. `--skip-shape-check` skips this step too.
  - **Vocabulary** (`https://linked.cm/ont/core/`, prefix `core:`, added to core's ontology module
    and `core.ttl`): classes `core:Component`, `core:SetComponent` (`rdfs:subClassOf
    core:Component`), `core:ComponentsGraph` (the graph kind CX registers, next to
    `core:ShapesGraph`); properties `core:definesComponent` (package → component),
    `core:exportName` (`xsd:string`), `core:startShape` and `core:queryShape` (→ a `sh:NodeShape`
    IRI), `core:query` (an `rdf:JSON` literal). `rdf:JSON` is added to core's `rdf` ontology module.
  - **IRIs.** A component: `{package IRI}/component/{encodeURIComponent(exportName)}`, where the
    package IRI is core's `getPackageUri(packageName)` (the root `shapes.ttl`'s shape IRIs hang
    off). CX stores the file's triples unchanged in `{package record IRI}/graph/components/{enc(key)}`
    (K1, D24); the component IRIs stay the package's.
  - **Per component.** `<package> core:definesComponent <component>`; `<component> a
    core:Component` (and `core:SetComponent` for a `linkedSetComponent`); `core:exportName`;
    `core:startShape` = the NodeShape IRI of the component's `.shape`; `core:queryShape` = the
    wire format's `shape`; `core:query` = `QueryBuilder.toJSON()` of the component's query (a set
    component's one-key `{prop: query}` wrapper unwrapped) as canonical JSON (object keys sorted
    recursively, arrays in order, no whitespace), typed `rdf:JSON`. Today start shape and query
    shape are the same IRI (react derives `.shape` from the query); D5 keeps them apart. A
    component whose query throws in `toJSON` is left out, with a build warning naming it.
  - **Queries bound at definition time** are recorded as `toJSON` writes them in the clean child,
    where no query context is set: `.for(getQueryContext('x'))` → `"subject":{"@ctx":"x"}`,
    `.for('<iri>')` → `"subject":"<iri>"`, `.for(null)` → `"nullSubject":true`. A query with a
    `subject` or `nullSubject` is bound: the builder gives it no `of`. `QueryBuilder.fromJSON`
    reads all three back.
  - **Determinism and hash.** One fixed prefix block (`core`, `rdf`, `xsd`), subjects sorted
    (package first, then components by IRI), `a` first and the other predicates sorted, one
    statement per line, no blank nodes; the same build gives the same bytes. The file carries no
    hash: CX hashes its bytes (SHA-256 hex, `core:contentHash` on the graph's registry record) and
    replaces the whole graph when the hash changes (D15).

  Example (`my-app`, one component of each kind; JSON shortened):
  ```turtle
  @prefix core: <https://linked.cm/ont/core/> .
  @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

  <https://linked.cm/pkg/my-app> core:definesComponent <https://linked.cm/pkg/my-app/component/PersonList> , <https://linked.cm/pkg/my-app/component/PersonPreview> .
  <https://linked.cm/pkg/my-app/component/PersonList> a core:Component , core:SetComponent ; core:exportName "PersonList" ; core:query "{\"fields\":[…],\"shape\":\"https://linked.cm/shape/schema/Person\",\"v\":1}"^^rdf:JSON ; core:queryShape <https://linked.cm/shape/schema/Person> ; core:startShape <https://linked.cm/shape/schema/Person> .
  <https://linked.cm/pkg/my-app/component/PersonPreview> a core:Component ; core:exportName "PersonPreview" ; core:query "{…}"^^rdf:JSON ; core:queryShape <https://linked.cm/shape/schema/Person> ; core:startShape <https://linked.cm/shape/schema/Person> .
  ```


## Steps

### CI — Component index generator (react half of K8)

**Depends on:** the core terms of CI phase 1 (`core:Component`, `core:SetComponent`,
`core:definesComponent`, `core:exportName`, `core:startShape`, `core:queryShape`, `core:query`,
`rdf:JSON`) landed and built in the master's core worktree. The CLI half (`Writing
components.ttl`) follows this one. One agent does the whole step (cli 004 §CI).

**Goal.** Given a package name and the exports of its `components/index`, `@_linked/react`
returns K8's Turtle: the generator lives with the component factory, so the format follows the
react release that writes it, and the CLI and CN never interpret component objects.

**Scope.**

1. `src/utils/componentIndex.ts` (subpath `@_linked/react/utils/componentIndex`, covered by the
   `./*` export):
   - `componentIndexEntries(packageName, moduleExports)` → `ComponentIndexEntry[]`
     (`{iri, exportName, set, startShape, queryShape, query}`), one per component object (an
     alias collapses to the code-point-smallest export name), sorted by IRI. A linked component is
     recognised by its markers (`.query`, `.shape`, `.original`), cross-copy safe
     (`isLinkedInstance(query, QueryBuilder)`, never `instanceof`).
   - `componentIndexTurtle(packageName, moduleExports)` → the Turtle (or `undefined` with no
     component) in K8's fixed form, plus warnings for components whose `toJSON` throws (left out).
     IRIs from core's `getPackageUri` and `coreOntology`/`rdf` accessors, not string literals.
   - Canonical JSON (keys sorted recursively) and Turtle string escaping, local to the module.
2. `createLinkedSetComponentFn` marks its result `setComponent: true`; `LinkedSetComponent`'s
   `query` type states what it holds at runtime (the QueryBuilder or the one-key wrapper);
   `LinkedComponent`/`LinkedSetComponent` gain the optional `setComponent` field.
3. Peer `@_linked/core` range raised to the core release with the K8 terms.
4. `README.md`: the `src/components/index.ts` convention (named exports; what is indexed; a
   query context set at module load serializes resolved).
5. Changeset (minor).

**Verify:** `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
component-index`; `npm test`; `npx linked build` clean; the CLI half's sandbox build (cli 004
§CI Verify) quotes a `components.ttl` generated by this code.

**Files found in code:**

- `src/utils/LinkedComponent.ts` — `LinkedComponentOptions` (126; `name` names the live-query
  template only), `createLinkedComponentFn` (253; `.original`/`.query`/`.shape` at 403-405,
  `registerPackageExport` only when the function has a name), `createLinkedSetComponentFn`
  (`.query` = the input, a one-key wrapper for set components, 561-563), `processQuery`
  (585-613; the start shape is derived from `query.toJSON().shape`), the `LinkedComponent` and
  `LinkedSetComponent` interfaces (89, 101).
- `src/package.ts` — `shapeToComponents` registry (shape → components, no package);
  `linkedComponent` built with `@_linked/react`'s own `registerPackageExport`, so it does not
  know the defining package. Not used by the index.
- `src/tests/` — Jest (ts-jest ESM, jsdom), `fixtures.ts`; `react-component-integration` needs
  Fuseki and is ignored by default.

**Pitfalls:** the start shape is the same class as the query shape today (both from the query);
keep the two fields anyway (D5). `options.name` is not the component's name: the index uses the
export name. A component with no export is not indexed (the builder could not import it).
Ordering must not depend on export order or on `toJSON`'s key order.

**Tests:** new `src/tests/component-index.test.tsx` (cases in cli 004 §CI Tests); existing
`react-component-behavior.test.tsx`, `classnames-and-query-context.test.tsx`,
`across-copies.test.tsx`, `native-barrel.test.tsx`, `reactivity.test.tsx`, `hooks.test.tsx` stay
green.

**Report:** `docs/reports/004-component-index.md` (the react half; the step's full report is cli
042). Plan doc: cli `docs/plans/005-component-index.md` (the step's one plan doc).

## Release

- After `@_linked/core` 2.46 (the K8 terms, core report 085) is published, raise the
  devDependency `@_linked/core` to `^2.46.0` (`npm install`) before react's release PR runs CI:
  `component-index.test.tsx` needs the terms. The peer range is already `^2.46.0`.

## Progress

- [x] CI — `componentIndexEntries`/`componentIndexTurtle`, set-component marker, type fix,
  README, changeset (report 004; whole step cli report 042)
