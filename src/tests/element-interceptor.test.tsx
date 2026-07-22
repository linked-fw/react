import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {act, render, waitFor} from '@testing-library/react';
import {linkedComponent, linkedSetComponent, linkedShape} from '../package.js';
import {Shape} from '@_linked/core/shapes/Shape';
import {literalProperty} from '@_linked/core/shapes/SHACL';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {
  registerElementInterceptor,
  useElementInterceptor,
} from '../utils/elementInterceptor.js';

/**
 * The element-interceptor seam through the REAL linkedComponent render path —
 * the headless repro for the OD-8 "editor installed but 0 stamps" live bug.
 * The probe interceptor replicates the editor's stamp: read `data-plan-node`
 * from the component's props and wrap the rendered element in a
 * display:contents span carrying the attribute.
 */

const personClass = {id: 'urn:test:ei:Person'};
const nameProp = {id: 'urn:test:ei:name'};

@linkedShape
class Person extends Shape {
  static targetClass = personClass;

  @literalProperty({path: nameProp, maxCount: 1})
  get name(): string {
    return '';
  }
}

class MockStore {
  async selectQuery(query: any): Promise<any> {
    if (query.singleResult) return {id: 'urn:test:ei:p1', name: 'Semmy'};
    return [
      {id: 'urn:test:ei:p1', name: 'Semmy'},
      {id: 'urn:test:ei:p2', name: 'Moa'},
    ];
  }
}

/** Editor-replica probe: stamp when props carry data-plan-node. */
const probeCalls: Array<Record<string, unknown> | undefined> = [];
const probeInterceptor = {
  useStamp(props: Record<string, unknown> | undefined) {
    probeCalls.push(props);
    const id = props?.['data-plan-node'] as string | undefined;
    return {
      stamp: (el: React.ReactNode) =>
        id
          ? React.createElement(
              'span',
              {'data-plan-node': id, style: {display: 'contents'}},
              el,
            )
          : el,
    };
  },
};

beforeEach(() => {
  probeCalls.length = 0;
  LinkedStorage.setDefaultDataset(new MockStore() as any);
  registerElementInterceptor(probeInterceptor);
});

afterEach(() => {
  registerElementInterceptor(undefined);
  jest.restoreAllMocks();
});

describe('element-interceptor seam through the real render path', () => {
  test('linkedComponent: a data-plan-node prop reaches the interceptor and the stamp lands in the DOM', async () => {
    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name}: any) => <div className="card">{name}</div>,
    );

    let container!: HTMLElement;
    await act(async () => {
      ({container} = render(
        <Card of={{id: 'urn:test:ei:p1'}} {...{'data-plan-node': 'iCard1'}} />,
      ));
    });

    // the interceptor's hook was called with props that INCLUDE the id
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls.some((p) => p?.['data-plan-node'] === 'iCard1')).toBe(true);

    // and the stamp wrapper is in the DOM around the rendered card
    const stamp = container.querySelector('[data-plan-node="iCard1"]');
    expect(stamp).not.toBeNull();
    // (data text is the harness's own queue mechanics — the behavior suite
    // covers it; here the subject is the STAMP around the rendered element)
    await waitFor(() => expect(stamp!.querySelector('.card')).not.toBeNull());
  });

  test('linkedSetComponent: the set wrapper stamps too', async () => {
    const List = linkedSetComponent(
      Person.select((p) => p.name),
      ({linkedData = []}: any) => (
        <ul>
          {linkedData.map((p: any) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      ),
    );

    let container!: HTMLElement;
    await act(async () => {
      ({container} = render(<List {...{'data-plan-node': 'iList1'}} />));
    });

    expect(probeCalls.some((p) => p?.['data-plan-node'] === 'iList1')).toBe(true);
    const stamp = container.querySelector('[data-plan-node="iList1"]');
    expect(stamp).not.toBeNull();
    expect(stamp!.querySelectorAll('li').length).toBe(2);
  });

  test('no interceptor registered → identity (no wrapper, no crash)', async () => {
    registerElementInterceptor(undefined);
    const Card = linkedComponent(
      Person.select((p) => p.name),
      ({name}: any) => <div className="card">{name}</div>,
    );
    let container!: HTMLElement;
    await act(async () => {
      ({container} = render(
        <Card of={{id: 'urn:test:ei:p1'}} {...{'data-plan-node': 'iCard1'}} />,
      ));
    });
    expect(container.querySelector('[data-plan-node="iCard1"]')).toBeNull();
    await waitFor(() => expect(container.querySelector('.card')).not.toBeNull());
  });
});
