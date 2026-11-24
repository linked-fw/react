---
'@_linked/react': major
---

`linkedPackage` (and the package's own exports) give `registerOntologies` in place of `linkedOntology`, which the core this release builds on no longer has. A package registers its ontologies from a generated `src/ontologies/index.ts` with `registerOntologies([...], import.meta.url)`; no package registers a prefix. The component index (`components.ttl`) declares the `core` namespace itself instead of reading it from core's ontology module; its bytes are unchanged.
