/**
 * Reactivity end to end: three linked components over one scripted dataset,
 * then mutations from every change source. The header and the member list
 * refetch; an unrelated card does not.
 */
import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import React from 'react';
import {act, render, screen, waitFor} from '@testing-library/react';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {getQueryContext, setQueryContext, PendingQueryContext} from '@_linked/core/queries/QueryContext';
import {invalidate, publishChange, resetLiveQueryStore} from '@_linked/core/live/LiveQueryStore';
import {linkedComponent} from '../package.js';
import {useLinkedQuery} from '../hooks/useLinkedQuery.js';
import {useLinkedSetQuery} from '../hooks/useLinkedSetQuery.js';
import {useQueryContext} from '../utils/useQueryContext.js';
import {Person, ScriptedDataset, Team, ids} from './fixtures.js';

const headerQuery = Team.select((t) => [t.name, t.members.size()]);
const membersQuery = Team.select((t) => t.members.name);
const cardQuery = Person.select((p) => [p.name, p.email]);

const TeamHeader = linkedComponent(headerQuery, ({name, members}) => (
  <h2 data-testid="header">
    {name} ({members as unknown as number})
  </h2>
));
const TeamMembers = linkedComponent(membersQuery, ({members}) => (
  <ul data-testid="members">
    {(members as Array<{id: string; name: string}>).map((m) => (
      <li key={m.id}>{m.name}</li>
    ))}
  </ul>
));
const PersonCard = linkedComponent(cardQuery, ({name, email}) => (
  <div data-testid="card">
    {name} {email}
  </div>
));
const QuietCard = linkedComponent(Person.select((p) => p.email), ({email}) => <div data-testid="quiet">{email}</div>, {
  reactive: false,
});

let dataset: ScriptedDataset;
const flush = () => new Promise<void>((r) => setTimeout(r, 20));

beforeEach(() => {
  resetLiveQueryStore();
  dataset = new ScriptedDataset();
  LinkedStorage.setDefaultDataset(dataset);
});

afterEach(() => {
  setQueryContext('user', null);
});

async function mountAll() {
  render(
    <>
      <TeamHeader of={{id: ids.T1}} />
      <TeamMembers of={{id: ids.T1}} />
      <PersonCard of={{id: ids.P9}} />
      <QuietCard of={{id: ids.P9}} />
    </>,
  );
  await waitFor(() => expect(screen.getByTestId('header').textContent).toBe('Core (2)'));
  await waitFor(() => expect(screen.getByTestId('members').textContent).toBe('SemmyMoa'));
  await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@x'));
  await waitFor(() => expect(screen.getByTestId('quiet').textContent).toBe('zed@x'));
  return {
    header: dataset.fetchesOf(headerQuery),
    members: dataset.fetchesOf(membersQuery),
    card: dataset.fetchesOf(cardQuery),
  };
}

describe('reactivity', () => {
  test('adding a member updates the header and the list, not the card', async () => {
    const before = await mountAll();
    await act(async () => {
      await Team.update({members: {add: [{id: ids.P3}]}}).for({id: ids.T1});
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('header').textContent).toBe('Core (3)'));
    await waitFor(() => expect(screen.getByTestId('members').textContent).toBe('SemmyMoaJinx'));
    expect(dataset.fetchesOf(headerQuery)).toBe(before.header + 1);
    expect(dataset.fetchesOf(membersQuery)).toBe(before.members + 1);
    expect(dataset.fetchesOf(cardQuery)).toBe(before.card);
  });

  test('renaming a member updates the list only', async () => {
    const before = await mountAll();
    await act(async () => {
      await Person.update({name: 'Semantha'}).for({id: ids.P1});
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('members').textContent).toBe('SemanthaMoa'));
    expect(dataset.fetchesOf(headerQuery)).toBe(before.header);
    expect(dataset.fetchesOf(cardQuery)).toBe(before.card);
  });

  test("changing the card's email updates the card and not the team components", async () => {
    const before = await mountAll();
    await act(async () => {
      await Person.update({email: 'zed@new'}).for({id: ids.P9});
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@new'));
    expect(dataset.fetchesOf(headerQuery)).toBe(before.header);
    expect(dataset.fetchesOf(membersQuery)).toBe(before.members);
    // Opted out of reactivity: still shows the old value.
    expect(screen.getByTestId('quiet').textContent).toBe('zed@x');
  });

  test('a remote change reported by the dataset feed refetches the same components', async () => {
    const before = await mountAll();
    // Simulate another client: the store's rows changed, and the dataset reports it.
    dataset.rows.get(ids.T1)!.members = [dataset.rows.get(ids.P1)!, dataset.rows.get(ids.P2)!, dataset.rows.get(ids.P4)!];
    act(() => {
      dataset.emit({
        mutation: Team.update({members: {add: [{id: ids.P4}]}}).for({id: ids.T1}).toJSON(),
        result: {id: ids.T1, members: {added: [{id: ids.P4}]}},
      });
    });
    await waitFor(() => expect(screen.getByTestId('header').textContent).toBe('Core (3)'));
    await waitFor(() => expect(screen.getByTestId('members').textContent).toBe('SemmyMoaQuinn'));
    expect(dataset.fetchesOf(cardQuery)).toBe(before.card);
  });

  test('publishChange from application code refetches', async () => {
    const before = await mountAll();
    dataset.rows.get(ids.T1)!.name = 'Platform';
    act(() => {
      publishChange({mutation: Team.update({name: 'Platform'}).for({id: ids.T1}).toJSON()});
    });
    await waitFor(() => expect(screen.getByTestId('header').textContent).toBe('Platform (2)'));
    expect(dataset.fetchesOf(cardQuery)).toBe(before.card);
  });

  test('invalidate(Team) refetches the team components', async () => {
    const before = await mountAll();
    await act(async () => {
      invalidate(Team);
      await flush();
    });
    expect(dataset.fetchesOf(headerQuery)).toBe(before.header + 1);
    expect(dataset.fetchesOf(membersQuery)).toBe(before.members + 1);
    expect(dataset.fetchesOf(cardQuery)).toBe(before.card);
  });

  test('a local mutation and its remote echo refetch once', async () => {
    const before = await mountAll();
    const mutation = Team.update({members: {add: [{id: ids.P3}]}}).for({id: ids.T1});
    const json = mutation.toJSON();
    await act(async () => {
      const result = await mutation;
      dataset.emit({mutation: json, result});
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('header').textContent).toBe('Core (3)'));
    expect(dataset.fetchesOf(headerQuery)).toBe(before.header + 1);
  });
});

describe('useQueryContext', () => {
  function Setter({value}: {value: {id: string}}) {
    useQueryContext('user', value, Person);
    return null;
  }

  test('clears the context on unmount only if its value is still current', async () => {
    const {unmount} = render(<Setter value={{id: ids.P1}} />);
    await waitFor(() => expect(getQueryContext('user').id).toBe(ids.P1));
    unmount();
    expect(getQueryContext('user')).toBeInstanceOf(PendingQueryContext);

    const first = render(<Setter value={{id: ids.P1}} />);
    await waitFor(() => expect(getQueryContext('user').id).toBe(ids.P1));
    render(<Setter value={{id: ids.P2}} />);
    await waitFor(() => expect(getQueryContext('user').id).toBe(ids.P2));
    first.unmount(); // its value is no longer current: must not clear P2
    expect(getQueryContext('user').id).toBe(ids.P2);
  });
});

describe('review regressions', () => {
  test('StrictMode: hook and component render data without throwing', async () => {
    function Card() {
      const {data} = useLinkedQuery(cardQuery, {id: ids.P9});
      return <span data-testid="hook">{data?.name ?? '…'}</span>;
    }
    render(
      <React.StrictMode>
        <Card />
        <PersonCard of={{id: ids.P9}} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('hook').textContent).toBe('Zed'));
    await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@x'));
    await act(async () => {
      await Person.update({email: 'zed@strict'}).for({id: ids.P9});
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@strict'));
  });

  test('a Shape instance as of is fetched, not treated as preloaded data', async () => {
    render(<PersonCard of={new Person({id: ids.P9})} />);
    await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@x'));
    expect(dataset.fetchesOf(cardQuery)).toBe(1);
  });

  test('useQueryContext with an inline value does not refetch on parent rerenders', async () => {
    const Me = linkedComponent(Person.select((p) => p.name).for(getQueryContext('user')), ({name}) => (
      <span data-testid="me">{name}</span>
    ));
    function Parent({n}: {n: number}) {
      useQueryContext('user', {id: ids.P1}, Person);
      return (
        <div data-n={n}>
          <Me />
        </div>
      );
    }
    const {rerender} = render(<Parent n={0} />);
    await waitFor(() => expect(screen.getByTestId('me').textContent).toBe('Semmy'));
    const before = dataset.selects;
    for (let i = 1; i <= 5; i++) rerender(<Parent n={i} />);
    await act(async () => {
      await flush();
    });
    expect(dataset.selects).toBe(before);
  });

  test('a component mounted before storage is configured loads once it is', async () => {
    LinkedStorage.setDefaultDataset(null as any);
    render(<PersonCard of={{id: ids.P9}} />);
    await act(async () => {
      LinkedStorage.setDefaultDataset(dataset);
      await flush();
    });
    await waitFor(() => expect(screen.getByTestId('card').textContent).toBe('Zed zed@x'));
  });

  test('an empty subject list renders an empty list without fetching', async () => {
    function List() {
      const {data, loading} = useLinkedSetQuery(cardQuery, []);
      return <span data-testid="list">{loading ? 'loading' : `rows: ${data?.length}`}</span>;
    }
    render(<List />);
    expect(screen.getByTestId('list').textContent).toBe('rows: 0');
    expect(dataset.selects).toBe(0);
  });
});
