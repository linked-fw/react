---
"@_linked/react": patch
---

A linked component given an instance of a sub-shape that exists only as data (a shape authored in a project, with no TypeScript class) now keeps that instance as its source. It used to replace it with a fresh instance of the component's own shape, because the inheritance check looked the sub-shape up by class and found none.
