import {useEffect, useMemo} from 'react';
import type {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import type {CountBuilder} from '@_linked/core/queries/CountBuilder';
import type {AskBuilder} from '@_linked/core/queries/AskBuilder';
import type {LiveQuery, LiveQueryOptions} from '@_linked/core/live/LiveQueryStore';
import {splitQuery, stableStringify} from '@_linked/core/live/keys';
import {useLiveQuery} from './useLiveQuery.js';
import {isCompleteQResult, subjectIdOf, type OfInput} from './of.js';

/** Any builder a hook can go live on. */
export type LiveableQuery = QueryBuilder<any, any, any> | CountBuilder | AskBuilder;

/** Options shared by the hooks and, through them, by the linked components. */
export type LinkedOptions = {
  /** `false` renders without subscribing (no fetch); the result reports `loading: false` and no data. */
  enabled?: boolean;
  /** `false` opts this query's template out of automatic refetching. */
  reactive?: boolean;
  /** Registry name for the template (database tuning, devtools). */
  name?: string;
};

/** The single-row result type of a builder. */
export type SingleResultOf<Q> =
  Q extends QueryBuilder<any, any, infer Res>
    ? Res extends (infer E)[]
      ? E
      : Res
    : Q extends CountBuilder
      ? number
      : Q extends AskBuilder
        ? boolean
        : unknown;

export type LinkedQueryResult<R> = {
  data: R | null | undefined;
  /** No data yet (first request pending or in flight). */
  loading: boolean;
  /** Data is present and a refetch is in flight. */
  refreshing: boolean;
  error?: Error;
  /** A single-subject select answered `null`. */
  notFound: boolean;
  refresh: () => Promise<void>;
  /** Local edit of the result, no request; overwritten by the next refetch. */
  patch: (partial: Partial<R> | ((current: R) => R)) => void;
};

const isSelect = (q: LiveableQuery): q is QueryBuilder<any, any, any> =>
  (q as {__queryKind?: string}).__queryKind === 'select';

/**
 * Keep a component in sync with one query.
 *
 * `of` binds the subject (`{id}`, a Shape, or a result object) and is optional
 * when the builder is already bound (`.for(id)`, `.for(getQueryContext(…))`)
 * or when it is a count or an ask. A result object in `of` that already holds
 * every selected label renders synchronously and subscribes to nothing: it is
 * a preloaded child, kept fresh by whoever loaded it.
 */
export function useLinkedQuery<Q extends LiveableQuery>(
  query: Q,
  of?: OfInput,
  options: LinkedOptions = {},
): LinkedQueryResult<SingleResultOf<Q>> {
  const enabled = options.enabled !== false;
  const select = isSelect(query);
  const preloaded = select && isCompleteQResult(of, query) ? (of as SingleResultOf<Q>) : undefined;
  const subjectId = subjectIdOf(of);

  // Bind with an `{id}` reference: a bare string would go through prefix resolution.
  const bound: LiveableQuery = select && subjectId ? (query as QueryBuilder<any, any, any>).for({id: subjectId}) : query;
  // The instance key is value-based: a new builder object or a new `of` object
  // with the same content maps to the same key, so nothing refetches on rerender.
  const key = enabled && !preloaded ? instanceKeyOf(bound) : null;
  const liveOptions = useLiveOptions(options);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures everything `bound` contributes
  const live = useMemo<LiveQuery<SingleResultOf<Q>> | null>(
    () => (key ? (bound as any).live(liveOptions) : null),
    [key, liveOptions],
  );
  useEffect(() => () => live?.close(), [live]);

  const state = useLiveQuery(live);
  const data = preloaded ?? state.data;
  return {
    data,
    loading: !!live && data === undefined && state.status !== 'error',
    refreshing: state.refreshing,
    error: state.error,
    notFound: state.notFound,
    refresh: () => (live ? live.refresh() : Promise.resolve()),
    patch: (partial) => live?.patch(partial as any),
  };
}

/** @internal Identity of the instance a bound builder maps to in the store. */
export function instanceKeyOf(query: LiveableQuery): string {
  const {templateJson, params} = splitQuery(query as any);
  return stableStringify(templateJson) + '|' + stableStringify(params);
}

/** @internal A stable options object (so it can be a memo dependency). */
export function useLiveOptions(options: LinkedOptions): LiveQueryOptions {
  const {name, reactive} = options;
  return useMemo(() => ({name, reactive}), [name, reactive]);
}
