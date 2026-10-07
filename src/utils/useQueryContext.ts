import {useEffect} from 'react';
import {getQueryContext, setQueryContext} from '@_linked/core/queries/QueryContext';
import type {Shape} from '@_linked/core/shapes/Shape';

/**
 * React hook that registers a value in the global query context.
 * Sets on mount / value change and clears on unmount — but only when the
 * value it set is still the current one, so a later setter is never undone by
 * an earlier component going away. Live queries bound to the context refetch
 * on their own when it changes.
 */
export function useQueryContext(
  name: string,
  value: any,
  shapeType?: new (...args: any[]) => Shape,
): void {
  useEffect(() => {
    if (!value) return;
    setQueryContext(name, value, shapeType);
    const setId = typeof value === 'object' ? (value as {id?: string}).id : undefined;
    return () => {
      const current = getQueryContext(name) as {id?: string} | undefined;
      if (setId && current?.id === setId) {
        setQueryContext(name, null);
      }
    };
  }, [name, value, shapeType]);
}
