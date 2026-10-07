import {useCallback, useState} from 'react';
import type {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import {DEFAULT_LIMIT} from '@_linked/core/utils/Package';
import {useLiveQuery} from './useLiveQuery.js';
import {useLive, usePreloadedState, type LinkedOptions, type SingleResultOf} from './useLinkedQuery.js';
import {isCompleteSetQResult, subjectIdsOf, type SetOfInput} from './of.js';

export type PageController = {
  next(): void;
  previous(): void;
  set(index: number): void;
  /** Change the page size; moves back to the first page. */
  setLimit(limit: number): void;
  index: number;
  limit: number;
};

export type LinkedSetQueryResult<Row> = {
  data: Row[] | undefined;
  loading: boolean;
  refreshing: boolean;
  error?: Error;
  /** Fetch now. On a preloaded array this makes the hook go live. */
  refresh: () => Promise<void>;
  patch: (rows: Row[] | ((current: Row[]) => Row[])) => void;
  page: PageController;
};

/**
 * Keep a component in sync with a list query.
 *
 * `of` narrows the list to given subjects (a ShapeSet or an array of `{id}`,
 * Shapes or result objects); omitted, the query runs over every instance; an
 * empty set renders an empty list without fetching. An array of complete
 * result objects renders synchronously without subscribing and is paged
 * client-side; `refresh()` makes it go live.
 */
export function useLinkedSetQuery<Q extends QueryBuilder<any, any, any>>(
  query: Q,
  of?: SetOfInput,
  options: LinkedOptions = {},
): LinkedSetQueryResult<SingleResultOf<Q>> {
  type Row = SingleResultOf<Q>;
  const enabled = options.enabled !== false;
  const preloaded = isCompleteSetQResult(of, query) ? (of as Row[]) : undefined;
  const subjects = subjectIdsOf(of);
  const empty = subjects !== undefined && subjects.length === 0;
  const local = usePreloadedState(subjects ? subjects.join(',') : undefined);

  const defaultLimit = query.toJSON().limit ?? DEFAULT_LIMIT;
  const [limit, setLimit] = useState<number>(defaultLimit);
  const [offset, setOffset] = useState<number>(0);

  let bound: QueryBuilder<any, any, any> = subjects && subjects.length ? query.forAll(subjects.map((id) => ({id}))) : query;
  if (limit) bound = bound.limit(limit);
  if (offset) bound = bound.offset(offset);

  const live = useLive<Row[]>(bound, {enabled: enabled && !empty && (!preloaded || local.selfFetch), options});
  const state = useLiveQuery(live);

  const fetched = state.data !== undefined && (!preloaded || local.selfFetch) ? state.data : undefined;
  const data: Row[] | undefined = empty
    ? []
    : fetched !== undefined
      ? fetched
      : preloaded
        ? limit
          ? preloaded.slice(offset, offset + limit)
          : preloaded
        : undefined;

  const refresh = useCallback(() => {
    if (preloaded && !local.selfFetch) {
      local.goLive();
      return Promise.resolve();
    }
    return live ? live.refresh() : Promise.resolve();
  }, [live, preloaded, local]);
  const patch = useCallback(
    (rows: Row[] | ((current: Row[]) => Row[])) => {
      live?.patch(rows as any);
    },
    [live],
  );

  const page: PageController = {
    next: () => setOffset(offset + limit),
    previous: () => setOffset(Math.max(0, offset - limit)),
    set: (index) => setOffset(index * limit),
    setLimit: (next) => {
      setLimit(next);
      setOffset(0);
    },
    index: limit ? Math.floor(offset / limit) : 0,
    limit,
  };

  return {
    data,
    loading: !!live && data === undefined && state.status !== 'error',
    refreshing: state.refreshing,
    error: state.error,
    refresh,
    patch,
    page,
  };
}
