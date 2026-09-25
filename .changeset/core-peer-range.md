---
'@_linked/react': minor
---

Narrow the `@_linked/core` peer range to ^2.22.8 (was ^2.10).

The old range long predated the core versions this package is actually built and
tested against; ^2.22.8 states the real requirement. Checked against every
package that depends on `@_linked/react` — auth, primitives, rdfs, schema,
shape-ui, sioc and the Create Now app — each already declares or resolves core
2.22.8, so none of them warns on this.

Narrowing a peer range is in principle a breaking change; it is released as a
minor because no dependent resolves a core below 2.22.8, and a major here would
propagate a needless breaking release through all six dependents.
