/**
 * Element-interceptor seam.
 *
 * A generic, single extension point for wrapping the element a linked component
 * produces at its two `createElement` render choke points. `@_linked/react`
 * ships NO interceptor — the default is an identity no-op with zero overhead. A
 * separate package MAY register one (e.g. a build that instruments rendering).
 * This is deliberately editor-agnostic: it is a render hook, nothing more.
 *
 * Rules of hooks: registration is expected exactly ONCE, before any linked
 * component first renders (register at bundle/bootstrap import time). The
 * registered `useStamp` is a hook, called on every render thereafter; a running
 * app must not flip registration state mid-session or the hook count changes.
 */

import type React from 'react';

export interface ElementInterceptor {
  /**
   * A hook, called during a linked component's render. Returns a `stamp(el)`
   * that may wrap the produced element. Must obey the rules of hooks.
   */
  useStamp(props: Record<string, unknown> | undefined): {
    stamp: (el: React.ReactNode) => React.ReactNode;
  };
}

const IDENTITY = {stamp: (el: React.ReactNode) => el};

/**
 * The registration lives on `globalThis`, NOT in module state. In a bundled dev
 * app the registering package and the rendering components can easily end up
 * importing DIFFERENT instances of this module (optimized-dep bundle vs
 * alias-resolved file vs a transitive copy) — module state would then split the
 * registry and the interceptor would silently never fire (the exact live
 * failure this replaced). One well-known global slot is instance-proof.
 */
const SLOT = '__linked_element_interceptor__';
type GlobalWithSlot = typeof globalThis & {[SLOT]?: ElementInterceptor};

/** Install the interceptor (or clear it with `undefined`). */
export function registerElementInterceptor(i: ElementInterceptor | undefined): void {
  (globalThis as GlobalWithSlot)[SLOT] = i;
}

/**
 * The seam the linked-component choke points call. Delegates to the registered
 * interceptor's hook when present; otherwise a no-op that returns the element
 * untouched (no hooks used — published builds pay nothing).
 */
export function useElementInterceptor(props: Record<string, unknown> | undefined): {
  stamp: (el: React.ReactNode) => React.ReactNode;
} {
  const interceptor = (globalThis as GlobalWithSlot)[SLOT];
  if (interceptor) return interceptor.useStamp(props);
  return IDENTITY;
}
