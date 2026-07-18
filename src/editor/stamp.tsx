/**
 * Plan-node stamping — plan-014 WP5 tasks 1–2.
 *
 * In an editor build, every linked-component instance carries its plan-node id
 * in the DOM as `data-plan-node`, so the canvas bridge can hit-test and box it.
 * The wrapped component is USER code that may not forward attributes, so we can't
 * pass `data-plan-node` as a prop and hope — instead we wrap the rendered element
 * in a `display: contents` span that carries the attribute WITHOUT generating a
 * box (no layout impact). The bridge walks `closest('[data-plan-node]')` from a
 * hovered element and measures the wrapper's children.
 *
 * Id source: an explicit `data-plan-node` on the component's props (generated
 * code can pass one) takes precedence; otherwise the nearest `PlanNodeContext`
 * (a parent section/page provides child ids). Published builds do none of this.
 */

import React, {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
} from 'react';
import { isEditorBuild } from './editorBuild.js';
import { isHeld, subscribeHold } from './holdRegistry.js';

export const PLAN_NODE_ATTR = 'data-plan-node';

/** The plan-node id of the current subtree (a parent stamps its children). */
export const PlanNodeContext = createContext<string | undefined>(undefined);

const DISPLAY_CONTENTS: React.CSSProperties = { display: 'contents' };

/** Resolve a node's id: explicit prop wins, else the surrounding context. */
export function resolvePlanNodeId(
  props: Record<string, unknown> | undefined,
  contextId: string | undefined,
): string | undefined {
  const fromProp = props?.[PLAN_NODE_ATTR] ?? (props as { planNodeId?: string })?.planNodeId;
  return (typeof fromProp === 'string' && fromProp) || contextId || undefined;
}

/** Wrap an element so it carries `data-plan-node` without affecting layout. */
export function stampNode(planNodeId: string, el: React.ReactNode): React.ReactElement {
  return React.createElement(
    'span',
    { [PLAN_NODE_ATTR]: planNodeId, style: DISPLAY_CONTENTS },
    el,
  );
}

/**
 * The seam the two `React.createElement(functionalComponent, …)` choke points
 * call. ONE hook (so React's rules hold), returns a `stamp(el)` that:
 *   - in a published build, or with no resolvable id → returns `el` untouched;
 *   - in an editor build → wraps `el` with the plan-node attribute, AND freezes
 *     the output while the node is held (suspend-rerender, WP5 task 2), resuming
 *     with fresh content when released.
 */
export function useEditorStamp(props: Record<string, unknown> | undefined): {
  planNodeId: string | undefined;
  stamp: (el: React.ReactNode) => React.ReactNode;
} {
  const contextId = useContext(PlanNodeContext);
  const planNodeId = resolvePlanNodeId(props, contextId);

  // Subscribe to this node's hold state; a toggle re-renders only its subscribers.
  const held = useSyncExternalStore(
    (cb) => (planNodeId ? subscribeHold(planNodeId, cb) : () => {}),
    () => (planNodeId ? isHeld(planNodeId) : false),
    () => false,
  );

  const frozen = useRef<React.ReactElement | null>(null);

  return {
    planNodeId,
    stamp: (el) => {
      if (!isEditorBuild() || !planNodeId) return el;
      if (held && frozen.current) return frozen.current; // suspend: keep last output
      const stamped = stampNode(planNodeId, el);
      frozen.current = stamped;
      return stamped;
    },
  };
}
