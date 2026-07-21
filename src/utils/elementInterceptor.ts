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

let interceptor: ElementInterceptor | undefined;

/** Install the interceptor (or clear it with `undefined`). */
export function registerElementInterceptor(i: ElementInterceptor | undefined): void {
  interceptor = i;
}

/**
 * The seam the linked-component choke points call. Delegates to the registered
 * interceptor's hook when present; otherwise a no-op that returns the element
 * untouched (no hooks used — published builds pay nothing).
 */
export function useElementInterceptor(props: Record<string, unknown> | undefined): {
  stamp: (el: React.ReactNode) => React.ReactNode;
} {
  if (interceptor) return interceptor.useStamp(props);
  return IDENTITY;
}
