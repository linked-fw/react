import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {act, render, screen, waitFor} from '@testing-library/react';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {getQueryContext, setQueryContext} from '@_linked/core/queries/QueryContext';
import {getLiveQueryStore, resetLiveQueryStore} from '@_linked/core/live/LiveQueryStore';
import {FieldSet} from '@_linked/core/queries/FieldSet';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {useLinkedQuery} from '../hooks/useLinkedQuery.js';
import {useLinkedSetQuery} from '../hooks/useLinkedSetQuery.js';
import {withQuery} from '../hooks/withQuery.js';
import {Person, ScriptedDataset, Team, ids} from './fixtures.js';

let dataset: ScriptedDataset;

beforeEach(() => {
  dataset = new ScriptedDataset();
  LinkedStorage.setDefaultDataset(dataset);
  resetLiveQueryStore();
});

afterEach(() => {
  setQueryContext('user', null);
  jest.useRealTimers();
});

const nameQuery = Person.select((p) => p.name);

function Card({id, enabled = true}: {id: string; enabled?: boolean}) {
  const {data, loading, refreshing, notFound} = useLinkedQuery(nameQuery, {id}, {enabled});
  if (loading) return <span role="status">loading</span>;
  if (notFound) return <span>not found</span>;
  return (
    <span data-refreshing={String(refreshing)}>{data ? data.name : 'no data'}</span>
  );
}

describe('useLinkedQuery', () => {
  test('loads a subject', async () => {
    render(<Card id={ids.P1} />);
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    expect(dataset.selects).toBe(1);
  });

  test('works with a bound builder and no of', async () => {
    function Bound() {
      const {data} = useLinkedQuery(Person.select((p) => p.name).for(ids.P2));
      return <span>{data?.name ?? '…'}</span>;
    }
    render(<Bound />);
    await waitFor(() => expect(screen.getByText('Moa')).toBeTruthy());
  });

  test('a count builder returns a number', async () => {
    function Total() {
      const {data} = useLinkedQuery(Team.select().toCount());
      return <span>{data === undefined ? '…' : `teams: ${data}`}</span>;
    }
    render(<Total />);
    await waitFor(() => expect(screen.getByText('teams: 1')).toBeTruthy());
  });

  test('a complete result object in of renders synchronously without fetching', () => {
    function Preloaded() {
      const {data, loading} = useLinkedQuery(nameQuery, {id: ids.P1, name: 'Preloaded'});
      return <span>{loading ? 'loading' : data?.name}</span>;
    }
    render(<Preloaded />);
    expect(screen.getByText('Preloaded')).toBeTruthy();
    expect(dataset.selects).toBe(0);
  });

  test('enabled: false neither fetches nor reports loading', () => {
    render(<Card id={ids.P1} enabled={false} />);
    expect(screen.getByText('no data')).toBeTruthy();
    expect(dataset.selects).toBe(0);
  });

  test('a null single result is notFound', async () => {
    render(<Card id="http://example.org/rt/entity/missing" />);
    await waitFor(() => expect(screen.getByText('not found')).toBeTruthy());
  });

  test('switching of renders cached data immediately and never refetches on rerender', async () => {
    const {rerender} = render(<Card id={ids.P1} />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    rerender(<Card id={ids.P2} />);
    expect(screen.getByRole('status')).toBeTruthy(); // not cached yet
    await waitFor(() => expect(screen.getByText('Moa')).toBeTruthy());
    rerender(<Card id={ids.P1} />);
    expect(screen.getByText('Semmy')).toBeTruthy(); // cached: no loader
    rerender(<Card id={ids.P1} />);
    rerender(<Card id={ids.P1} />);
    expect(dataset.selects).toBe(2);
  });

  test('refresh keeps data on screen and reports refreshing', async () => {
    let refresh!: () => Promise<void>;
    function Refreshable() {
      const r = useLinkedQuery(nameQuery, {id: ids.P1});
      refresh = r.refresh;
      return <span>{r.data?.name ?? '…'}{r.refreshing ? ' (updating)' : ''}</span>;
    }
    render(<Refreshable />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    const d = dataset.defer();
    let done!: Promise<void>;
    act(() => {
      done = refresh();
    });
    await waitFor(() => expect(screen.getByText('Semmy (updating)')).toBeTruthy());
    await act(async () => {
      d.resolve({id: ids.P1, name: 'Semmy 2'});
      await done;
    });
    await waitFor(() => expect(screen.getByText('Semmy 2')).toBeTruthy());
  });

  test('a pending query context renders once the context lands, without a parent rerender', async () => {
    function Me() {
      const {data, loading} = useLinkedQuery(Person.select((p) => p.name).for(getQueryContext('user')));
      return <span>{loading ? 'waiting' : data?.name}</span>;
    }
    render(<Me />);
    expect(screen.getByText('waiting')).toBeTruthy();
    expect(dataset.selects).toBe(0);
    act(() => {
      setQueryContext('user', {id: ids.P4}, Person);
    });
    await waitFor(() => expect(screen.getByText('Quinn')).toBeTruthy());
  });

  test('unmount closes the handle; the template is dropped after the grace period', async () => {
    const {unmount} = render(<Card id={ids.P1} />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    expect(getLiveQueryStore().templates()).toHaveLength(1);
    jest.useFakeTimers();
    unmount();
    act(() => {
      jest.advanceTimersByTime(getLiveQueryStore().options.gcMs + 1);
    });
    expect(getLiveQueryStore().templates()).toHaveLength(0);
  });
});

describe('useLinkedSetQuery', () => {
  const pagedQuery = Person.select((p) => p.name).limit(2);

  function List({of}: {of?: ShapeSet<Person> | Array<{id: string}>}) {
    const {data, loading, page} = useLinkedSetQuery(pagedQuery, of);
    if (loading) return <span role="status">loading</span>;
    return (
      <div>
        <ul>{(data ?? []).map((row) => <li key={row.id}>{row.name}</li>)}</ul>
        <span>page {page.index + 1} / limit {page.limit}</span>
        <button onClick={() => page.next()}>next</button>
        <button onClick={() => page.previous()}>previous</button>
        <button onClick={() => page.setLimit(3)}>limit 3</button>
      </div>
    );
  }

  test('lists, pages and changes the page size', async () => {
    render(<List />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    expect(screen.getByText('Moa')).toBeTruthy();
    expect(screen.queryByText('Jinx')).toBeNull();
    act(() => screen.getByText('next').click());
    await waitFor(() => expect(screen.getByText('Jinx')).toBeTruthy());
    expect(screen.getByText('page 2 / limit 2')).toBeTruthy();
    act(() => screen.getByText('limit 3').click());
    await waitFor(() => expect(screen.getByText('page 1 / limit 3')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Jinx')).toBeTruthy());
    expect(screen.getByText('Semmy')).toBeTruthy();
  });

  test('narrows to the subjects in of, whether a ShapeSet or an array', async () => {
    const set = new ShapeSet([new Person({id: ids.P4}), new Person({id: ids.P5})]);
    const {rerender} = render(<List of={set} />);
    await waitFor(() => expect(screen.getByText('Quinn')).toBeTruthy());
    expect(screen.queryByText('Semmy')).toBeNull();
    rerender(<List of={[{id: ids.P9}]} />);
    await waitFor(() => expect(screen.getByText('Zed')).toBeTruthy());
  });

  test('a fresh ShapeSet with the same ids on every render does not refetch', async () => {
    function Parent({n}: {n: number}) {
      return <List of={new ShapeSet([new Person({id: ids.P4})])} key={n > 100 ? 'x' : undefined} />;
    }
    const {rerender} = render(<Parent n={0} />);
    await waitFor(() => expect(screen.getByText('Quinn')).toBeTruthy());
    for (let i = 1; i <= 5; i++) rerender(<Parent n={i} />);
    expect(dataset.selects).toBe(1);
  });

  test('complete result objects in of are paged client-side without fetching', async () => {
    const rows = [ids.P1, ids.P2, ids.P3, ids.P4].map((id, i) => ({id, name: `row${i}`}));
    render(<List of={rows as any} />);
    expect(screen.getByText('row0')).toBeTruthy();
    expect(screen.queryByText('row2')).toBeNull();
    act(() => screen.getByText('next').click());
    expect(screen.getByText('row2')).toBeTruthy();
    expect(dataset.selects).toBe(0);
  });
});

describe('withQuery', () => {
  test('exposes statics, registers a pinned template and is preloadable', () => {
    function Plain({name}: {name: string}) {
      return <span>{name}</span>;
    }
    const Named = withQuery(Plain, nameQuery, {name: 'plainName'});
    expect(Named.query).toBe(nameQuery);
    expect(Named.shape).toBe(Person);
    expect(FieldSet.extractComponentFieldSet(Named)?.labels()).toEqual(['name']);
    expect(getLiveQueryStore().templates().map((t) => t.name)).toEqual(['plainName']);
    // A parent can preload for it.
    const parent = Team.select((t) => t.lead.preloadFor(Named));
    expect(JSON.stringify(parent.toJSON())).toContain('name');
  });
});
