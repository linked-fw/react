import {useEffect, useRef} from 'react';
import {getQueryContext, setQueryContext} from '@_linked/core/queries/QueryContext';
import type {Shape} from '@_linked/core/shapes/Shape';

/**
 * React hook that registers a value in the global query context.
 *
 * Sets on mount and whenever the value's identity (`id` for objects) changes —
 * a new object with the same id on every parent render is not a change — and
 * clears on unmount, but only when the value it set is still the current one,
 * so a later setter is never undone by an earlier component going away. Live
 * queries bound to the context refetch on their own when it changes.
 */
export function useQueryContext(
  name: string,
  value: any,
  shapeType?: new (...args: any[]) => Shape,
): void {
  const identity = value && typeof value === 'object' ? ((value as {id?: string}).id ?? value) : value;
  const lastSet = useRef<unknown>(undefined);

  useEffect(() => {
    if (!value) return;
    setQueryContext(name, value, shapeType);
    lastSet.current = identity;
  }, [name, identity, shapeType]); // eslint-disable-line react-hooks/exhaustive-deps -- `value` is represented by `identity`

  useEffect(
    () => () => {
      const current = getQueryContext(name) as {id?: string} | undefined;
      const mine = lastSet.current;
      if (mine !== undefined && (current?.id ?? current) === mine) {
        setQueryContext(name, null);
      }
    },
    [name],
  );
}
