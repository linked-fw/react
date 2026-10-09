# Changelog

## 2.0.0

### Major Changes

- [#81](https://github.com/linked-fw/react/pull/81) [`d4f9101`](https://github.com/linked-fw/react/commit/d4f9101b1fc929db814af9143fc800807dbe22eb) Thanks [@flyon](https://github.com/flyon)! - Reactive components and hooks on top of `@_linked/core`'s live queries.
  
  **Breaking:** the `@_linked/core` peer range is now `^2.27.0`, the first core release with live queries (`query.live()`, `subscribeQueryDispatch`, `queryDependencies`, `mutationEffects`). Nothing in the component API was removed or renamed.
  
  - `linkedComponent` / `linkedSetComponent` are rebuilt on the core live-query store. After any mutation — local (`await Shape.update(...)`), reported by a dataset's change feed, or published with `publishChange()` — every mounted component whose query can have read the changed data refetches and rerenders; nothing else does. Data stays on screen during a refetch; `_refreshing` is injected next to `_refresh`; identical queries share one request; a subject that is already cached renders immediately.
  - New `notFoundElement` option/prop (resolved like `loader`) for a single-subject query that answers `null`; new `name` and `reactive` options (`reactive: false` opts a component out of automatic refetching).
  - New hooks `useLinkedQuery(query, of?, options?)` and `useLinkedSetQuery(query, of?, options?)` for components that need several queries, state-dependent queries, conditional fetching or inline counts. Hook-based components are not discoverable (no static `query`); use `linkedComponent` for anything that should be preloadable or listed with its data requirements. `invalidate`, `publishChange` and `getLiveQueryStore` are re-exported from core.
  - Fixed: a `linkedSetComponent` defined before storage was configured never loaded; a new `ShapeSet`/array per parent render refetched every render; a fast `of` change could render an older response; a component bound to a pending query context did not update when the context landed; `useQueryContext` now clears on unmount (only if its value is still the current one).
  
  Behaviour notes: `_refresh(patch)` now edits the shared cached result (visible to every component on the same query and subject until the next refetch); `reactive` and `name` apply to the query template; the set component's `query.setLimit()` returns to the first page; a `Shape` instance passed as `of` is now always fetched (it was mistaken for preloaded data); a component mounted before storage is configured loads once storage is set; an empty `of` set renders an empty list without fetching; `useQueryContext` no longer re-sets the context when a parent passes a new object with the same id. Hooks and components are StrictMode-safe.

## 1.6.4

### Patch Changes

- [#79](https://github.com/linked-fw/react/pull/79) [`3bc2291`](https://github.com/linked-fw/react/commit/3bc2291ca8af5225bcc06dfd42a1d60beceb663e) Thanks [@flyon](https://github.com/flyon)! - A linked component given an instance of a sub-shape that exists only as data (a shape authored in a project, with no TypeScript class) now keeps that instance as its source. It used to replace it with a fresh instance of the component's own shape, because the inheritance check looked the sub-shape up by class and found none.

## 1.6.3

### Patch Changes

- [#76](https://github.com/linked-fw/react/pull/76) [`a91d8ed`](https://github.com/linked-fw/react/commit/a91d8ed9cede3a0fbbcaf6d2c0bad83a0d9935a6) Thanks [@flyon](https://github.com/flyon)! - Remove unused dependency react-usestateref

## 1.6.2

### Patch Changes

- [#68](https://github.com/linked-fw/react/pull/68) [`21149f0`](https://github.com/linked-fw/react/commit/21149f0a0a84e17a990dac9394da55458261e205) Thanks [@flyon](https://github.com/flyon)! - Subpath imports written with a `.js` extension (`@_linked/react/<path>.js`) now resolve. The exports map had no `./*.js` entry, so `./*` turned them into `<path>.js.js` and Node, Vite and TypeScript (node16/bundler) all failed to find them. This matches the exports map of the other Linked packages.

## 1.6.1

### Patch Changes

- [#55](https://github.com/linked-fw/react/pull/55) [`15d3a37`](https://github.com/linked-fw/react/commit/15d3a3796edac7fed655b80b194a6f3e491d8af9) Thanks [@flyon](https://github.com/flyon)! - Sourcemaps now embed their TypeScript source, so consumers no longer see 'points to missing source files' warnings.

## 1.6.0

### Minor Changes

- [#52](https://github.com/linked-fw/react/pull/52) [`df073f9`](https://github.com/linked-fw/react/commit/df073f9d9041150b566d49e087bb99241df52f33) Thanks [@flyon](https://github.com/flyon)! - Narrow the `@_linked/core` peer range to ^2.22.8 (was ^2.10).

  The old range long predated the core versions this package is actually built and
  tested against; ^2.22.8 states the real requirement. Checked against every
  package that depends on `@_linked/react` — auth, primitives, rdfs, schema,
  shape-ui, sioc and the Create Now app — each already declares or resolves core
  2.22.8, so none of them warns on this.

  Narrowing a peer range is in principle a breaking change; it is released as a
  minor because no dependent resolves a core below 2.22.8, and a major here would
  propagate a needless breaking release through all six dependents.

## 1.5.3

### Patch Changes

- [#50](https://github.com/linked-fw/react/pull/50) [`7bf0fec`](https://github.com/linked-fw/react/commit/7bf0fecaa2334c1a8e28edaba621fda7c61816ca) Thanks [@flyon](https://github.com/flyon)! - Build against `@_linked/core@^2.22.8` (was `^2.21.0`), and pin it in the lockfile.

  Patch rather than minor: core is a **devDependency** here, so this changes only what CI
  compiles and tests against, not what a consumer installs. The `peerDependencies` range
  is deliberately left at `^2.10` — a peer range states compatibility, and narrowing it
  would force a core upgrade on every consumer of this package, which is a separate
  decision from keeping our own build current.

## 1.5.2

### Patch Changes

- [#47](https://github.com/linked-fw/react/pull/47) [`1a07460`](https://github.com/linked-fw/react/commit/1a074601e2908bb056ba048e749f902b324ffbf5) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 1.5.1

### Patch Changes

- [#44](https://github.com/linked-fw/react/pull/44) [`df85a0e`](https://github.com/linked-fw/react/commit/df85a0ed60c6ecc2d4cb778563e4fd9fa3562389) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo and mark `package-lock.json` as a generated file. No script changes were needed: nothing in this package invoked `yarn`.

## 1.5.0

### Minor Changes

- [#37](https://github.com/linked-cm/react/pull/37) [`03c1d42`](https://github.com/linked-cm/react/commit/03c1d42112b3ad229f4f4814b3d17987ab1fa78e) Thanks [@flyon](https://github.com/flyon)! - Support React 19 and React Native.

  - The `react` peer range is now `^18.2.0 || ^19.0.0`. On React 19 apps (such as any current Expo SDK), `npm install` no longer fails with `ERESOLVE`, so you can remove the `overrides` workaround.
  - New `@_linked/react/native` entry point. It exports the same API as `@_linked/react`. Importing it sets `LinkedComponentDefaults.loader` to an `ActivityIndicator` (`testID="linked-loader"`) and `LinkedComponentDefaults.errorElement` to an alert `Text` reading "Failed to load" (`testID="linked-error"`), unless your app has already set them. It also replaces `LinkedInfinityLoader` with an `ActivityIndicator`. The built-in `<svg>` loader and error elements crash on React Native, so React Native apps should import from `@_linked/react/native`. If your app set these defaults itself as a workaround, you can remove that code.
  - `react-native` (`>=0.76`) is an optional peer dependency. The root entry doesn't import it, so web behaviour is unchanged.

## 1.4.2

### Patch Changes

- [#31](https://github.com/linked-cm/react/pull/31) [`efed05e`](https://github.com/linked-cm/react/commit/efed05ec8bfe539dd718344e5fd3c7508312705e) Thanks [@flyon](https://github.com/flyon)! - `classnames` is now inlined (the `cl` helper's API is unchanged) and the external `classnames` dependency is dropped. The external package is CJS and broke native-ESM standalone bundles; consumers already import `cl` from `@_linked/react/utils/ClassNames`, so no change is needed on their side.

## 1.4.1

### Patch Changes

- [#26](https://github.com/linked-cm/react/pull/26) [`c7d61ff`](https://github.com/linked-cm/react/commit/c7d61ff7c72874e18b657dc54886b11cbdd814ce) Thanks [@flyon](https://github.com/flyon)! - Fix build against current `@_linked/core`: define the query-driven-component types (`QueryController`, `QueryControllerProps`, `ToQueryResultSet`, `GetCustomObjectKeys`) locally instead of importing them from `@_linked/core/queries/SelectQuery`, where core removed them as "dead" (only react used them; same pattern as the already-local `GetQueryResponseType`/`QueryWrapperObject`). Bump the `@_linked/core` peer to `^2.13`. Also drops the dead `development` export condition.

## 1.4.0

### Minor Changes

- [#23](https://github.com/linked-cm/react/pull/23) [`b436d21`](https://github.com/linked-cm/react/commit/b436d21eccd4241b208e60dae1e25524783d1f2c) Thanks [@flyon](https://github.com/flyon)! - ESM-only build + core 2.10.x compatibility fix.

  - **`.build()` removal:** the client preload path in `LinkedComponent` called
    `getQueryDispatch().selectQuery(requestQuery.build())`. `QueryBuilder.build()`
    was removed in `@_linked/core` 2.10.x — datasets now receive the live/closed
    query directly. Both the single and set component paths now pass `requestQuery`
    straight to `selectQuery`. Required for consumers on core ≥ 2.10.x.
  - **ESM-only:** the package now ships ESM only. `package.json` gains
    `"type": "module"`, `main`/`module`/`types` point at `lib/esm`, and every
    `require` condition is dropped from `exports`. The dual (CJS+ESM) build and the
    `dual-package` post-step are removed; `build` is a single `tsc -p tsconfig-esm.json`.

## 1.3.1

### Patch Changes

- [#17](https://github.com/linked-cm/react/pull/17) [`582f100`](https://github.com/linked-cm/react/commit/582f100932e432a49a75c038b3e9d564245bcccb) Thanks [@flyon](https://github.com/flyon)! - Fixed an infinite recursion in `linkedPackage`. The exported function was spreading `linkedPackage(packageName)` (itself) into its own return value instead of delegating to `coreLinkedPackage(packageName)` from `@_linked/core`, so any call to `import { linkedPackage } from '@_linked/react/package'` followed by `linkedPackage(...)` immediately blew the stack with `Maximum call stack size exceeded`. Almost certainly the root cause of the "stack overflow during client hydration" symptom reported against 1.3.0.

  `linkedPackage(name)` now correctly returns `{ linkedComponent, linkedSetComponent, ...coreLinkedPackage(name) }` — i.e. the React-only helpers plus everything `@_linked/core`'s `linkedPackage` provides (`linkedShape`, `linkedUtil`, `linkedOntology`, `registerPackageExport`, `packageExports`, `packageName`, …).

## 1.3.0

### Minor Changes

- [#13](https://github.com/linked-cm/react/pull/13) [`f4688d5`](https://github.com/linked-cm/react/commit/f4688d5c04f97070318f58fceae61d0280562b27) Thanks [@flyon](https://github.com/flyon)! - Loader / errorElement resolution chain, `_refresh` on `linkedSetComponent`, factory overloads, `LinkedInfinityLoader` opt-in export.

  **New: factory overloads.** `linkedComponent` and `linkedSetComponent` now accept three forms:

  ```ts
  linkedComponent(query, fn); // existing
  linkedComponent(query, fn, { loader, errorElement }); // new — positional options
  linkedComponent({ query, component, loader, errorElement }); // new — config object
  ```

  **New: loader resolution.** Resolves in order — per-instance `loader={<X/>}` prop → factory `options.loader` → `LinkedComponentDefaults.loader` → built-in `<svg class="ld-loader"/>`. Apps style `.ld-loader` (default styles ship in `@_linked/css`'s `loader.css`) or replace the element via `LinkedComponentDefaults.loader = <MyLoader />`.

  **New: error handling.** Both wrappers now capture query errors and resolve an `errorElement` in the same chain (per-instance prop → factory option → global default → built-in `<svg class="ld-error"/>`). Pass the sentinel `'rethrow'` (per-instance or as a global default) to let an external `<ErrorBoundary>` handle the error instead.

  **New: `_refresh` on `linkedSetComponent`.** Mirrors the `linkedComponent` API — `_refresh()` re-runs the query, `_refresh(updatedProps)` patches local query-result state for optimistic UI.

  **New: `LinkedInfinityLoader`.** Opt-in branded loader exported from `@_linked/react`. Tree-shake-safe via the package's new `sideEffects` array form.

  **Tree-shaking.** `package.json` now declares `"sideEffects": ["./lib/cjs/package.js", "./lib/esm/package.js"]` so bundlers drop unused named exports (the package-registration module is whitelisted).

  No breaking changes — all existing `linkedComponent(query, fn)` and `linkedSetComponent(query, fn)` call sites work unchanged.

## 1.2.1

### Patch Changes

- [#8](https://github.com/Semantu/linked-react/pull/8) [`fac333c`](https://github.com/Semantu/linked-react/commit/fac333c81c913d515ad70af53c13f0e9bc8737a4) Thanks [@flyon](https://github.com/flyon)! - `linkedComponent` now shows a loading spinner while a `PendingQueryContext` resolves instead of logging a warning and returning null. `loadData` handles null/error results gracefully. Fuseki test URL uses shared `FUSEKI_BASE_URL` constant.

## 1.2.0

### Minor Changes

- [#5](https://github.com/Semantu/linked-react/pull/5) [`ed0e99d`](https://github.com/Semantu/linked-react/commit/ed0e99d942fd9b5dfc936a5759d5c591ac470a04) Thanks [@linked-cm](https://github.com/linked-cm)! - Migrate from `SelectQueryFactory` to `QueryBuilder` for compatibility with `@_linked/core` v2.x. Replace removed `Shape.queryParser` with `getQueryDispatch()`, update all type signatures and runtime code to use the immutable `QueryBuilder` API (`.for()`, `.forAll()`, `.limit()`, `.offset()`, `.build()`). Query result types are now correctly inferred from `QueryBuilder` generic parameters. Requires `@_linked/core` ^2.2.0 as peer dependency.

### Patch Changes

- [#4](https://github.com/Semantu/linked-react/pull/4) [`58522a9`](https://github.com/Semantu/linked-react/commit/58522a9b7be5a2c7d8e279704da7dd2bc371cba4) Thanks [@flyon](https://github.com/flyon)! - Upgrade to @\_linked/core@2.2.1
  Fix `preloadFor` rendering wrong entity and add Fuseki integration tests.
  Added 7 Fuseki-backed integration tests covering `linkedComponent` and `linkedSetComponent`:
  Tests use a custom Jest environment (`jest-environment-jsdom-with-fetch`) that restores Node's native `fetch` in jsdom, and auto-start Fuseki via Docker when needed.

## 1.0.0

### Major Changes

Initial extraction from the LINCD monolith. Moves React-specific linked component wrappers into a standalone package.

- `linkedComponent(...)` and `linkedSetComponent(...)` extracted from `lincd`.
- `LinkedComponentClass` base class for class-based linked components.
- `useStyles(...)` hook for component styling.
- Pagination API (`nextPage`, `previousPage`, `setPage`, `setLimit`) on linked set components.
- `_refresh(updatedProps?)` for optimistic UI updates on linked components.
