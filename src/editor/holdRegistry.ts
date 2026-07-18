/**
 * Suspend-rerender registry — plan-014 WP5 task 2.
 *
 * During an inline text edit, live data updates must NOT blow away the node the
 * user is editing (cursor/selection loss, mid-keystroke re-mount). The bridge
 * HOLDS a plan node for the duration of the edit; a held linked component freezes
 * its output (returns the last rendered element) instead of re-rendering with new
 * data, and resumes — re-rendering with current data — when released.
 *
 * A tiny external store so components subscribe with `useSyncExternalStore`
 * (React 18): only the held node's subscribers re-render on a toggle, and the
 * hold survives across the node's own re-renders because it lives outside React.
 */

type Listener = () => void;

const held = new Set<string>();
const listeners = new Map<string, Set<Listener>>();

function notify(planNodeId: string): void {
  listeners.get(planNodeId)?.forEach((l) => l());
}

/** Hold a node (freeze its re-render). Idempotent. */
export function holdNode(planNodeId: string): void {
  if (held.has(planNodeId)) return;
  held.add(planNodeId);
  notify(planNodeId);
}

/** Release a node (resume; it re-renders with current data). Idempotent. */
export function releaseNode(planNodeId: string): void {
  if (!held.delete(planNodeId)) return;
  notify(planNodeId);
}

export function isHeld(planNodeId: string): boolean {
  return held.has(planNodeId);
}

/** Subscribe to hold-state changes for one node. Returns an unsubscribe. */
export function subscribeHold(planNodeId: string, listener: Listener): () => void {
  let set = listeners.get(planNodeId);
  if (!set) {
    set = new Set();
    listeners.set(planNodeId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(planNodeId);
  };
}

/** Test/reset helper — clears all holds and listeners. */
export function __resetHolds(): void {
  held.clear();
  listeners.clear();
}
