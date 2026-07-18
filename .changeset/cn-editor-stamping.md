---
'@_linked/react': minor
---

Add the CN visual-builder editor runtime (plan-014 WP5): plan-node stamping,
suspend-rerender hold registry, and the iframe-side bridge.

- **`data-plan-node` stamping** at the two `linkedComponent` / `linkedSetComponent`
  render sites, gated by `isEditorBuild()` (a build-time flag, not `NODE_ENV`).
  Editor builds wrap each rendered instance in a `display: contents` span
  carrying its plan-node id — no layout impact, no attribute leakage into
  published builds.
- **Suspend-rerender seam**: a per-node hold registry (`holdNode`/`releaseNode`)
  freezes a node's output during an inline text edit so live data updates don't
  blow away the edit, resuming with current data on release.
- **Editor bridge** (`createBridge`, `hitTest`, `boundingBox`, `beginTextEdit`/
  `endTextEdit`): hit-tests a point to a plan node, measures its box, toggles
  the hold, and relays events to the editor shell. Lives under `editor/` in this
  package for now (OD-9); no new package required.

All inert and tree-shakeable in published builds. New exports under the package
root: `isEditorBuild`, `setEditorBuild`, `PlanNodeContext`, `useEditorStamp`,
`stampNode`, `holdNode`, `releaseNode`, `createBridge`, and friends.
