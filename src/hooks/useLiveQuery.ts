import {useCallback, useSyncExternalStore} from 'react';
import type {LiveQuery, LiveState} from '@_linked/core/live/LiveQueryStore';

const IDLE: LiveState<any> = {status: 'pending', notFound: false, refreshing: false};
const noopSubscribe = () => () => {};
const idleSnapshot = () => IDLE;

/**
 * Subscribe a component to a live query handle. The handle's `state` object is
 * replaced on every change and stable otherwise, which is exactly what
 * `useSyncExternalStore` needs as a snapshot. On the server the idle state is
 * returned, so SSR renders the loading branch.
 */
export function useLiveQuery<R>(live: LiveQuery<R> | null): LiveState<R> {
  const subscribe = useCallback(
    (onChange: () => void) => (live ? live.subscribe(onChange) : noopSubscribe()),
    [live],
  );
  const getSnapshot = useCallback(() => (live ? live.state : (IDLE as LiveState<R>)), [live]);
  return useSyncExternalStore(subscribe, getSnapshot, idleSnapshot as () => LiveState<R>);
}
