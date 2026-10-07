import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
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
  /** `false` opts this query's template — every query with this exact template — out of automatic refetching. */
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
  /** Fetch now. On a preloaded result this makes the hook go live (subscribe and fetch). */
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
 * a preloaded child, kept fresh by whoever loaded it. `patch()` then edits a
 * local copy and `refresh()` makes the hook go live; both reset when the
 * subject changes.
 */
export function useLinkedQuery<Q extends LiveableQuery>(
  query: Q,
  of?: OfInput,
  options: LinkedOptions = {},
): LinkedQueryResult<SingleResultOf<Q>> {
  const enabled = options.enabled !== false;
  query = useStableContextQuery(query);
  const select = isSelect(query);
  const subjectId = subjectIdOf(of);
  const preloaded = select && isCompleteQResult(of, query as QueryBuilder<any, any, any>) ? (of as Record<string, unknown>) : undefined;
  const local = usePreloadedState(subjectId);
  const live = useLive(select && subjectId ? (query as QueryBuilder<any, any, any>).for({id: subjectId}) : query, {
    enabled: enabled && (!preloaded || local.selfFetch),
    options,
  });
  const state = useLiveQuery(live);

  const fetched = state.data !== undefined && (!preloaded || local.selfFetch) ? state.data : undefined;
  const data = (fetched !== undefined ? fetched : preloaded ? {...preloaded, ...local.patch} : undefined) as
    | SingleResultOf<Q>
    | null
    | undefined;

  const refresh = useCallback(() => {
    if (preloaded && !local.selfFetch) {
      local.goLive();
      return Promise.resolve();
    }
    return live ? live.refresh() : Promise.resolve();
  }, [live, preloaded, local]);
  const patch = useCallback(
    (partial: Partial<SingleResultOf<Q>> | ((current: SingleResultOf<Q>) => SingleResultOf<Q>)) => {
      if (preloaded && !local.selfFetch) local.applyPatch(partial as any);
      else live?.patch(partial as any);
    },
    [live, preloaded, local],
  );

  return {
    data,
    loading: !!live && data === undefined && state.status !== 'error',
    refreshing: state.refreshing,
    error: state.error,
    notFound: state.notFound,
    refresh,
    patch,
  };
}

/**
 * `.for(getQueryContext(name))` binds a context reference while the context is
 * unset but a plain subject once it is set, so an inline builder changes
 * identity on the render after the context lands. Keep the context-bound
 * builder for as long as a new one is the same template bound to that
 * context's current subject; the store re-keys it when the context changes.
 */
function useStableContextQuery<Q extends LiveableQuery>(query: Q): Q {
  const ref = useRef<{query: Q; template: string; contextName?: string} | null>(null);
  const {templateJson, params} = splitQuery(query as any);
  const template = stableStringify(templateJson);
  const prev = ref.current;
  if (
    prev &&
    prev.contextName &&
    prev.template === template &&
    !params.contextName &&
    params.subject !== undefined &&
    params.subject === splitQuery(prev.query as any).params.subject
  ) {
    return prev.query;
  }
  ref.current = {query, template, contextName: params.contextName};
  return query;
}

// ---------------------------------------------------------------------------
// Shared by useLinkedSetQuery
// ---------------------------------------------------------------------------

/** @internal Identity of the instance a bound builder maps to in the store. */
export function instanceKeyOf(query: LiveableQuery): string {
  const {templateJson, params} = splitQuery(query as any);
  return stableStringify(templateJson) + '|' + stableStringify(params);
}

/**
 * @internal The live handle for a bound builder, created once per instance key
 * and closed when it changes or the component unmounts. Creating the handle
 * during render is a benign side effect: an unsubscribed handle holds nothing
 * and its instance is released after the grace period. React StrictMode closes
 * and re-subscribes the same handle, which the handle supports.
 */
export function useLive<R>(bound: LiveableQuery, args: {enabled: boolean; options: LinkedOptions}): LiveQuery<R> | null {
  const key = args.enabled ? instanceKeyOf(bound) : null;
  const {name, reactive} = args.options;
  const liveOptions = useMemo<LiveQueryOptions>(() => ({name, reactive}), [name, reactive]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures everything `bound` contributes
  const live = useMemo<LiveQuery<R> | null>(() => (key ? (bound as any).live(liveOptions) : null), [key, liveOptions]);
  useEffect(() => () => live?.close(), [live]);
  return live;
}

type PreloadedState = {
  selfFetch: boolean;
  patch: Record<string, unknown>;
  goLive(): void;
  applyPatch(partial: Record<string, unknown> | ((current: unknown) => unknown)): void;
};

/** @internal Local state of a preloaded result, reset whenever the subject changes. */
export function usePreloadedState(subjectKey: string | undefined): PreloadedState {
  const [state, setState] = useState<{key: string | undefined; selfFetch: boolean; patch: Record<string, unknown>}>({
    key: subjectKey,
    selfFetch: false,
    patch: {},
  });
  const current = state.key === subjectKey ? state : {key: subjectKey, selfFetch: false, patch: {}};
  return useMemo(
    () => ({
      selfFetch: current.selfFetch,
      patch: current.patch,
      goLive: () => setState({key: subjectKey, selfFetch: true, patch: {}}),
      applyPatch: (partial) =>
        setState((s) => {
          const base = s.key === subjectKey ? s : {key: subjectKey, selfFetch: false, patch: {}};
          const next = typeof partial === 'function' ? (partial(base.patch) as Record<string, unknown>) : {...base.patch, ...partial};
          return {...base, patch: next};
        }),
    }),
    [current.selfFetch, current.patch, subjectKey],
  );
}
