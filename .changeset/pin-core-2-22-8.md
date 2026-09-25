---
'@_linked/react': patch
---

Build against `@_linked/core@^2.22.8` (was `^2.21.0`), and pin it in the lockfile.

Patch rather than minor: core is a **devDependency** here, so this changes only what CI
compiles and tests against, not what a consumer installs. The `peerDependencies` range
is deliberately left at `^2.10` — a peer range states compatibility, and narrowing it
would force a core upgrade on every consumer of this package, which is a separate
decision from keeping our own build current.
