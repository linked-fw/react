/**
 * CN visual-builder editor runtime — plan-014 WP5.
 *
 * The `@_linked/react` editor surface: plan-node stamping, the suspend-rerender
 * hold registry, and the iframe-side bridge. All inert in published builds
 * (guarded by `isEditorBuild()`); tree-shakeable for apps that never edit.
 */

export { isEditorBuild, setEditorBuild } from './editorBuild.js';
export {
  PLAN_NODE_ATTR,
  PlanNodeContext,
  resolvePlanNodeId,
  stampNode,
  useEditorStamp,
} from './stamp.js';
export {
  holdNode,
  releaseNode,
  isHeld,
  subscribeHold,
} from './holdRegistry.js';
export {
  hitTest,
  boundingBox,
  beginTextEdit,
  endTextEdit,
  createBridge,
  type BridgeMessage,
  type BridgeOptions,
} from './bridge.js';
