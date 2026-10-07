import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {linkedComponent, linkedSetComponent, linkedShape} from '../package.js';
import {Shape} from '@_linked/core/shapes/Shape';
import {literalProperty} from '@_linked/core/shapes/SHACL';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {getSourceFromInputProps} from '../utils/LinkedComponent.js';
import {useStyles} from '../utils/Hooks.js';
import {LinkedComponentClass} from '../utils/LinkedComponentClass.js';
import {getQueryContext, setQueryContext} from '@_linked/core/queries/QueryContext';
import {resetLiveQueryStore} from '@_linked/core/live/LiveQueryStore';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return {promise, resolve};
}

const personClass = {id: 'urn:test:gap:Person'};
const dogClass = {id: 'urn:test:gap:Dog'};
const catClass = {id: 'urn:test:gap:Cat'};
const nameProp = {id: 'urn:test:gap:name'};

@linkedShape
class Person extends Shape {
  static targetClass = personClass;

  @literalProperty({path: nameProp, maxCount: 1})
  get name(): string {
    return '';
  }
}

@linkedShape
class Dog extends Person {
  static targetClass = dogClass;
}

@linkedShape
class Cat extends Shape {
  static targetClass = catClass;
}

class TestLinkedClass extends LinkedComponentClass<Person> {
  static shape = Person;

  render() {
    return <div>ok</div>;
  }
}

class BrokenLinkedClass extends LinkedComponentClass<Person> {
  render() {
    return <div>broken</div>;
  }
}

/**
 * A mock IDataset that returns configurable results.
 * Tracks calls for assertions.
 */
class MockStore {
  calls: Array<{offset?: number; limit?: number; singleResult?: boolean}> = [];
  private singleResult: any = {id: 'urn:test:gap:p1', name: 'Semmy'};
  private setResult = [
    {id: 'urn:test:gap:p1', name: 'Semmy'},
    {id: 'urn:test:gap:p2', name: 'Moa'},
    {id: 'urn:test:gap:p3', name: 'Jinx'},
    {id: 'urn:test:gap:p4', name: 'Quinn'},
    {id: 'urn:test:gap:p5', name: 'Rex'},
  ];
  private queue: Array<Promise<any>> = [];

  setSingleResult(result: {id: string; name: string}) {
    this.singleResult = result;
  }

  queueResult(resultPromise: Promise<any>) {
    this.queue.push(resultPromise);
  }

  async selectQuery(query: any): Promise<any> {
    const json = typeof query?.toJSON === 'function' ? query.toJSON() : query;
    // A subject-bound query (`.for(id)`) is inherently single-result; on the
    // serialized form that shows up as a `subject` even when the explicit
    // `singleResult` flag isn't emitted.
    const isSingle = json.singleResult || json.subject != null;
    this.calls.push({
      offset: json.offset,
      limit: json.limit,
      singleResult: isSingle,
    });

    if (this.queue.length > 0) {
      return this.queue.shift();
    }

    if (isSingle) {
      return this.singleResult;
    }

    const offset = json.offset || 0;
    const limit = json.limit || this.setResult.length;
    return this.setResult.slice(offset, offset + limit);
  }
}

let store: MockStore;

beforeEach(() => {
  resetLiveQueryStore();
  store = new MockStore();
  LinkedStorage.setDefaultDataset(store as any);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('React component behavior', () => {
  test('shows loader before linkedComponent query resolves', async () => {
    const deferred = createDeferred<any>();
    store.queueResult(deferred.promise);

    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name}) => <div>{name}</div>,
    );

    render(<Card of={{id: 'urn:test:gap:p1'}} />);

    expect(screen.getByRole('status', {name: 'Loading'})).toBeTruthy();

    await act(async () => {
      deferred.resolve({id: 'urn:test:gap:p1', name: 'Semmy'});
      await deferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
    });
  });

  test('shows loader before linkedSetComponent query resolves', async () => {
    const deferred = createDeferred<any>();
    store.queueResult(deferred.promise);

    const NameList = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}) => (
        <ul>
          {linkedData.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      ),
    );

    render(<NameList />);

    expect(screen.getByRole('status', {name: 'Loading'})).toBeTruthy();

    await act(async () => {
      deferred.resolve([
        {id: 'urn:test:gap:p1', name: 'Semmy'},
        {id: 'urn:test:gap:p2', name: 'Moa'},
      ]);
      await deferred.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
      expect(screen.getByText('Moa')).toBeTruthy();
    });
  });

  test('_refresh() refetches data and rerenders', async () => {
    let singleValue = 'Semmy';
    store.setSingleResult({id: 'urn:test:gap:p1', name: singleValue});

    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name, _refresh}) => (
        <div>
          <span>{name}</span>
          <button
            onClick={() => {
              singleValue = 'Moa';
              store.setSingleResult({id: 'urn:test:gap:p1', name: singleValue});
              _refresh();
            }}
          >
            refresh
          </button>
        </div>
      ),
    );

    render(<Card of={{id: 'urn:test:gap:p1'}} />);

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('refresh'));

    await waitFor(() => {
      expect(screen.getByText('Moa')).toBeTruthy();
    });

    expect(store.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('_refresh(updatedProps) patches query-result props without refetch', async () => {
    const singleNameQuery = Person.select((p) => p.name);
    const Card = linkedComponent<typeof singleNameQuery, {title: string}>(
      singleNameQuery,
      ({name, _refresh, title}) => (
        <div>
          <span>{title}</span>
          <span>{name}</span>
          <button onClick={() => _refresh({name: 'Patched'})}>patch</button>
        </div>
      ),
    );

    render(<Card of={{id: 'urn:test:gap:p1'}} title="CustomTitle" />);

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
    });

    const callsBeforePatch = store.calls.length;
    fireEvent.click(screen.getByText('patch'));

    await waitFor(() => {
      expect(screen.getByText('Patched')).toBeTruthy();
      expect(screen.getByText('CustomTitle')).toBeTruthy();
    });

    expect(store.calls.length).toBe(callsBeforePatch);
  });

  test('warns and renders null when linkedComponent has no source and no bound subject', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name}) => <div>{name}</div>,
    );

    const component = render(React.createElement(Card, {} as any));

    expect(component.container.innerHTML).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('requires a source to be provided'),
    );
  });

  test('throws on invalid linkedSetComponent input prop type', () => {
    // Silences React's error logging for the thrown render. React 18 reported
    // it via console.error; React 19 reports uncaught render errors through
    // window.reportError instead, so the spy is not asserted on.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const NameList = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}) => (
        <ul>
          {linkedData.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      ),
    );

    expect(() =>
      render(React.createElement(NameList, {of: {id: 'urn:test:gap:p1'}} as any)),
    ).toThrow("Invalid argument 'of' provided");
  });

  test('throws on invalid query-wrapper object formats', () => {
    const query = Person.select((p) => p.name);

    expect(() =>
      linkedSetComponent({a: query, b: query} as any, () => null),
    ).toThrow('Only one key is allowed');

    expect(() =>
      linkedSetComponent({a: 123} as any, () => null),
    ).toThrow('Unknown value type for query object');

    expect(() =>
      linkedSetComponent(123 as any, () => null),
    ).toThrow('Unknown data query type');
  });

  test('rejects when selectQuery is called without a configured store', async () => {
    // Setting null store means selectQuery will reject past the payload-shape
    // validation. Provide a `shape` so the payload passes the shape guard added
    // in core 2.14.4 and reaches the no-store check.
    LinkedStorage.setDefaultDataset(null as any);

    await expect(
      LinkedStorage.selectQuery({shape: {id: 'urn:test-shape'}} as any),
    ).rejects.toThrow('No query dataset configured');

    // Restore store for subsequent tests
    LinkedStorage.setDefaultDataset(store as any);
  });

  test('linkedSetComponent query controller methods update paging', async () => {
    let controller: any;
    const pagedQuery = Person.select((p) => p.name).limit(2);
    const NameList = linkedSetComponent(
      pagedQuery,
      ({linkedData = [], query}) => {
        controller = query;
        return (
          <ul>
            {linkedData.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        );
      },
    );

    render(<NameList />);

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
      expect(screen.getByText('Moa')).toBeTruthy();
    });

    act(() => {
      controller.nextPage();
    });

    await waitFor(() => {
      expect(screen.getByText('Jinx')).toBeTruthy();
      expect(screen.getByText('Quinn')).toBeTruthy();
    });

    act(() => {
      controller.previousPage();
    });

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
      expect(screen.getByText('Moa')).toBeTruthy();
    });

    act(() => {
      controller.setLimit(3);
    });

    await waitFor(() => {
      expect(screen.getByText('Jinx')).toBeTruthy();
    });

    act(() => {
      controller.setPage(1);
    });

    await waitFor(() => {
      expect(screen.getByText('Quinn')).toBeTruthy();
      expect(screen.getByText('Rex')).toBeTruthy();
    });
  });

  test('getSourceFromInputProps handles node references and shape inheritance', () => {
    const fromNodeReference = getSourceFromInputProps(
      {of: {id: 'urn:test:gap:p100'}},
      Person,
    );
    expect(fromNodeReference).toBeInstanceOf(Person);
    expect(fromNodeReference.id).toBe('urn:test:gap:p100');

    const dog = new Dog({id: 'urn:test:gap:dog1'});
    const personFromDog = getSourceFromInputProps({of: dog}, Person);
    expect(personFromDog).toBe(dog);

    const cat = new Cat({id: 'urn:test:gap:cat1'});
    const personFromCat = getSourceFromInputProps({of: cat}, Person);
    expect(personFromCat).toBeInstanceOf(Person);
    expect(personFromCat).not.toBe(cat);
    expect(personFromCat.id).toBe('urn:test:gap:cat1');
  });

  test('linked components expose shape/query metadata for package registration usage', () => {
    const query = Person.select((p) => p.name);
    const Card = linkedComponent(query, ({name}) => <div>{name}</div>);
    const SetList = linkedSetComponent(query, ({linkedData = []}) => (
      <ul>
        {linkedData.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    ));

    expect(Card.shape).toBe(Person);
    expect(Card.query).toBe(query);
    expect(SetList.shape).toBe(Person);
    expect(SetList.query).toBe(query);
  });

  test('linked set query supports array QResult input and applies client-side slicing', async () => {
    const pagedQuery = Person.select((p) => p.name).limit(2);
    const NameList = linkedSetComponent(
      pagedQuery,
      ({linkedData = [], query}) => (
        <div>
          <button onClick={() => query?.nextPage()}>next</button>
          <ul>
            {linkedData.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </div>
      ),
    );

    const prefetched = [
      {id: 'urn:test:gap:p1', name: 'Semmy'},
      {id: 'urn:test:gap:p2', name: 'Moa'},
      {id: 'urn:test:gap:p3', name: 'Jinx'},
      {id: 'urn:test:gap:p4', name: 'Quinn'},
    ];

    render(<NameList of={prefetched as any} />);

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
      expect(screen.getByText('Moa')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('next'));

    await waitFor(() => {
      expect(screen.getByText('Jinx')).toBeTruthy();
      expect(screen.getByText('Quinn')).toBeTruthy();
    });

    // With valid prefetched results, store should not execute requests.
    expect(store.calls.length).toBe(0);
  });

  test('linked set accepts ShapeSet as input', async () => {
    const NameList = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}) => (
        <ul>
          {linkedData.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      ),
    );

    const set = new ShapeSet([
      new Person({id: 'urn:test:gap:p1'}),
      new Person({id: 'urn:test:gap:p2'}),
    ]);

    render(<NameList of={set} />);

    await waitFor(() => {
      expect(screen.getByText('Semmy')).toBeTruthy();
      expect(screen.getByText('Moa')).toBeTruthy();
    });
  });
});

describe('React utility helpers', () => {
  test('useStyles merges class names and styles, filtering falsy values', () => {
    const result = useStyles(
      {
        className: ['base', '', null, 'active'],
        style: {color: 'red'},
        other: 'value',
      },
      ['extra', false as any, 'focus'],
      {fontWeight: 'bold'},
    );

    expect(result.className).toBe('base active extra focus');
    expect(result.style).toEqual({color: 'red', fontWeight: 'bold'});
    expect(result.other).toBe('value');
    expect((result as any).className.includes('  ')).toBe(false);
  });

  test('useStyles supports string class input and style object input', () => {
    const withClass = useStyles({className: 'root'}, 'extra-class');
    expect(withClass.className).toBe('root extra-class');

    const withStyles = useStyles({style: {color: 'blue'}}, {marginTop: 4});
    expect(withStyles.style).toEqual({color: 'blue', marginTop: 4});
  });

  test('LinkedComponentClass sourceShape resolves and resets when source changes', () => {
    const ref = React.createRef<TestLinkedClass>();

    const firstSource = new Person({id: 'urn:test:gapclass:p1'});
    const secondSource = new Person({id: 'urn:test:gapclass:p2'});

    const {rerender} = render(
      <TestLinkedClass source={firstSource} _refresh={() => {}} ref={ref} />,
    );

    const firstShape = ref.current.sourceShape;
    expect(firstShape.id).toBe('urn:test:gapclass:p1');

    rerender(
      <TestLinkedClass source={secondSource} _refresh={() => {}} ref={ref} />,
    );

    const secondShape = ref.current.sourceShape;
    expect(secondShape.id).toBe('urn:test:gapclass:p2');
    expect(secondShape).not.toBe(firstShape);
  });

  test('LinkedComponentClass sourceShape throws when class is not linked to a shape', () => {
    const ref = React.createRef<BrokenLinkedClass>();

    render(
      <BrokenLinkedClass
        source={new Person({id: 'urn:test:gapclass:p1'}) as any}
        _refresh={() => {}}
        ref={ref}
      />,
    );

    expect(() => ref.current.sourceShape).toThrow(
      'BrokenLinkedClass is not linked to a shape',
    );
  });

  test('LinkedComponentClass sourceShape returns null when no source is provided', () => {
    const ref = React.createRef<TestLinkedClass>();

    render(<TestLinkedClass source={null as any} _refresh={() => {}} ref={ref} />);

    expect(ref.current.sourceShape).toBeNull();
  });
});

describe('React component behavior on the live-query store', () => {
  test('_refreshing is true during _refresh() and the current data stays rendered', async () => {
    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name, _refresh, _refreshing}) => (
        <div>
          <span data-testid="name">{name}</span>
          <span data-testid="refreshing">{String(_refreshing)}</span>
          <button onClick={() => _refresh()}>refresh</button>
        </div>
      ),
    );
    render(<Card of={{id: 'urn:test:gap:p1'}} />);
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('Semmy'));
    expect(screen.getByTestId('refreshing').textContent).toBe('false');

    const deferred = createDeferred<any>();
    store.queueResult(deferred.promise);
    fireEvent.click(screen.getByText('refresh'));
    await waitFor(() => expect(screen.getByTestId('refreshing').textContent).toBe('true'));
    expect(screen.getByTestId('name').textContent).toBe('Semmy');

    await act(async () => {
      deferred.resolve({id: 'urn:test:gap:p1', name: 'Semmy 2'});
      await deferred.promise;
    });
    await waitFor(() => expect(screen.getByTestId('name').textContent).toBe('Semmy 2'));
    expect(screen.getByTestId('refreshing').textContent).toBe('false');
  });

  test('notFoundElement renders for a null single result; without it the component renders with empty props', async () => {
    store.queueResult(Promise.resolve(null));
    const Plain = linkedComponent(
      Person.select((p) => p.name),
      ({name}) => <div>name: {name ?? 'none'}</div>,
    );
    render(<Plain of={{id: 'urn:test:gap:missing'}} />);
    await waitFor(() => expect(screen.getByText('name: none')).toBeTruthy());

    store.queueResult(Promise.resolve(null));
    const WithOption = linkedComponent(
      Person.select((p) => p.name),
      ({name}) => <div>{name}</div>,
      {notFoundElement: <em>nobody here</em>},
    );
    render(<WithOption of={{id: 'urn:test:gap:missing2'}} />);
    await waitFor(() => expect(screen.getByText('nobody here')).toBeTruthy());

    store.queueResult(Promise.resolve(null));
    render(<Plain of={{id: 'urn:test:gap:missing3'}} notFoundElement={<em>instance says no</em>} />);
    await waitFor(() => expect(screen.getByText('instance says no')).toBeTruthy());
  });

  test('a set component defined before storage is configured still loads', async () => {
    LinkedStorage.setDefaultDataset(null as any);
    const NameList = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}) => (
        <ul>
          {linkedData.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      ),
    );
    LinkedStorage.setDefaultDataset(store as any);
    render(<NameList />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
  });

  test('a fresh ShapeSet on every parent render does not refetch', async () => {
    const NameList = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}) => (
        <ul>
          {linkedData.map((item) => (
            <li key={item.id}>{item.name}</li>
          ))}
        </ul>
      ),
    );
    const Parent = ({n}: {n: number}) => (
      <div data-n={n}>
        <NameList of={new ShapeSet([new Person({id: 'urn:test:gap:p1'}), new Person({id: 'urn:test:gap:p2'})])} />
      </div>
    );
    const {rerender} = render(<Parent n={0} />);
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    for (let i = 1; i <= 5; i++) rerender(<Parent n={i} />);
    await waitFor(() => expect(screen.getByText('Moa')).toBeTruthy());
    expect(store.calls.length).toBe(1);
  });

  test('a fast of change renders the latest subject even when responses arrive out of order', async () => {
    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name}) => <div>{name}</div>,
    );
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    store.queueResult(first.promise);
    store.queueResult(second.promise);
    const {rerender} = render(<Card of={{id: 'urn:test:gap:p1'}} />);
    rerender(<Card of={{id: 'urn:test:gap:p2'}} />);
    await act(async () => {
      second.resolve({id: 'urn:test:gap:p2', name: 'Moa'});
      await second.promise;
    });
    await waitFor(() => expect(screen.getByText('Moa')).toBeTruthy());
    await act(async () => {
      first.resolve({id: 'urn:test:gap:p1', name: 'Semmy'});
      await first.promise;
    });
    expect(screen.getByText('Moa')).toBeTruthy();
    expect(screen.queryByText('Semmy')).toBeNull();
  });

  test('a component bound to a pending query context renders when the context lands, without a parent rerender', async () => {
    const Me = linkedComponent(
      Person.select((p) => p.name).for(getQueryContext('behaviour-user')),
      ({name}) => <div>{name}</div>,
    );
    render(<Me of={undefined as any} />);
    expect(screen.getByRole('status', {name: 'Loading'})).toBeTruthy();
    act(() => {
      setQueryContext('behaviour-user', {id: 'urn:test:gap:p1'}, Person);
    });
    await waitFor(() => expect(screen.getByText('Semmy')).toBeTruthy());
    setQueryContext('behaviour-user', null);
  });
});
