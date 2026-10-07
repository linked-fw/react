import {useEffect, useMemo, useState} from 'react';
import type {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import type {LiveQuery} from '@_linked/core/live/LiveQueryStore';
import {DEFAULT_LIMIT} from '@_linked/core/utils/Package';
import {useLiveQuery} from './useLiveQuery.js';
import {instanceKeyOf, useLiveOptions, type LinkedOptions} from './useLinkedQuery.js';
import {isCompleteSetQResult, subjectIdsOf, type SetOfInput} from './of.js';

/** The row type of a set builder. */
export type RowOf<Q> = Q extends QueryBuilder<any, any, infer Res> ? (Res extends (infer E)[] ? E : Res) : unknown;

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
  refresh: () => Promise<void>;
  patch: (rows: Row[] | ((current: Row[]) => Row[])) => void;
  page: PageController;
};

/**
 * Keep a component in sync with a list query.
 *
 * `of` narrows the list to given subjects (a ShapeSet or an array of `{id}`,
 * Shapes or result objects); omitted, the query runs over every instance. An
 * array of complete result objects renders synchronously without subscribing
 * and is paged client-side, as before.
 */
export function useLinkedSetQuery<Q extends QueryBuilder<any, any, any>>(
  query: Q,
  of?: SetOfInput,
  options: LinkedOptions = {},
): LinkedSetQueryResult<RowOf<Q>> {
  const enabled = options.enabled !== false;
  const preloaded = isCompleteSetQResult(of, query) ? (of as RowOf<Q>[]) : undefined;
  const subjects = subjectIdsOf(of);

  const defaultLimit = query.toJSON().limit ?? DEFAULT_LIMIT;
  const [limit, setLimit] = useState<number>(defaultLimit);
  const [offset, setOffset] = useState<number>(0);

  let bound: QueryBuilder<any, any, any> = subjects ? query.forAll(subjects) : query;
  if (limit) bound = bound.limit(limit);
  if (offset) bound = bound.offset(offset);

  const key = enabled && !preloaded ? instanceKeyOf(bound) : null;
  const liveOptions = useLiveOptions(options);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures everything `bound` contributes
  const live = useMemo<LiveQuery<RowOf<Q>[]> | null>(
    () => (key ? (bound as any).live(liveOptions) : null),
    [key, liveOptions],
  );
  useEffect(() => () => live?.close(), [live]);

  const state = useLiveQuery(live);
  const data = preloaded ? (limit ? preloaded.slice(offset, offset + limit) : preloaded) : state.data;

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
    data: data as RowOf<Q>[] | undefined,
    loading: !!live && data === undefined && state.status !== 'error',
    refreshing: state.refreshing,
    error: state.error,
    refresh: () => (live ? live.refresh() : Promise.resolve()),
    patch: (rows) => live?.patch(rows as any),
    page,
  };
}
