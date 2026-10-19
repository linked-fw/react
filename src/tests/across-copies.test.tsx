/**
 * A second copy of this package or of `@_linked/core` (Vite's SSR runner next to Node, or two
 * bundles) must not break it. Each test loads a second copy of the modules with
 * `jest.isolateModulesAsync`, which gives that copy its own module registry: its own
 * `@_linked/react` and its own `@_linked/core`.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {render} from '@testing-library/react';
import {sharedStateKey} from '@_linked/core/utils/sharedState';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {resetLiveQueryStore} from '@_linked/core/live/LiveQueryStore';
import * as copyA from '../package.js';
import {getSourceFromInputProps} from '../utils/LinkedComponent.js';
import {isCompleteQResult, ownPropsOf, subjectIdOf, subjectIdsOf} from '../hooks/of.js';
import {Person, ScriptedDataset} from './fixtures.js';

type Registry = {shapeToComponents: Map<unknown, Set<unknown>>};

function registry(): Registry {
  const key = sharedStateKey('@_linked/react', 'componentRegistry');
  return (globalThis as unknown as Record<symbol, Registry>)[key];
}

type CopyB = {
  pkg: typeof copyA;
  fixtures: typeof import('./fixtures.js');
  ShapeSet: typeof ShapeSet;
};

async function loadCopyB(): Promise<CopyB> {
  let loaded: CopyB | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = {
      pkg: await import('../package.js'),
      fixtures: await import('./fixtures.js'),
      ShapeSet: (await import('@_linked/core/collections/ShapeSet')).ShapeSet,
    };
  });
  if (!loaded) throw new Error('second copy did not load');
  return loaded;
}

beforeEach(() => {
  resetLiveQueryStore();
  LinkedStorage.setDefaultDataset(new ScriptedDataset());
});

test('the second copy is a separate module, with its own core', async () => {
  const copyB = await loadCopyB();
  expect(copyB.pkg.linkedComponent).not.toBe(copyA.linkedComponent);
  expect(copyB.fixtures.Person).not.toBe(Person);
  expect(copyB.ShapeSet).not.toBe(ShapeSet);
});

describe('component registry across copies', () => {
  test('components registered through either copy land in one registry', async () => {
    const copyB = await loadCopyB();

    const CardA = copyA.linkedComponent(Person.select((p) => p.name), ({name}) => (
      <span>{name}</span>
    ));
    const PersonB = copyB.fixtures.Person;
    const CardB = copyB.pkg.linkedComponent(PersonB.select((p) => p.name), ({name}) => (
      <span>{name}</span>
    ));

    // The key is the shape class each copy resolved from the query, from core's registry.
    const shared = registry();
    expect(shared).toBeDefined();
    expect(shared.shapeToComponents.get(CardA.shape)?.has(CardA)).toBe(true);
    expect(shared.shapeToComponents.get(CardB.shape)?.has(CardB)).toBe(true);
  });
});

describe('core classes from a second copy of core', () => {
  test('a query built by the other copy is a query', async () => {
    const copyB = await loadCopyB();
    const queryB = copyB.fixtures.Person.select((p) => p.name);

    expect(() => copyA.linkedComponent(queryB, ({name}) => <span>{name}</span>)).not.toThrow();
    expect(() =>
      copyA.linkedSetComponent({people: queryB}, ({people}) => <span>{people.length}</span>),
    ).not.toThrow();
  });

  test('a Shape from the other copy is a subject, not plain data', async () => {
    const copyB = await loadCopyB();
    const personB = new copyB.fixtures.Person({id: 'urn:test:copies:p1'});
    const query = Person.select((p) => p.name);

    expect(subjectIdOf(personB)).toBe('urn:test:copies:p1');
    expect(isCompleteQResult(personB, query)).toBe(false);
    expect(ownPropsOf(personB)).toEqual({});
    // Its node shape is the other copy's, so the component wraps the same node in its own class.
    const source = getSourceFromInputProps({of: personB}, Person);
    expect(source).toBeInstanceOf(Person);
    expect(source.id).toBe('urn:test:copies:p1');
  });

  test('a ShapeSet from the other copy is a set of subjects', async () => {
    const copyB = await loadCopyB();
    const set = new copyB.ShapeSet([new copyB.fixtures.Person({id: 'urn:test:copies:p2'})]);

    expect(subjectIdsOf(set)).toEqual(['urn:test:copies:p2']);

    const List = copyA.linkedSetComponent(Person.select((p) => p.name), () => <span>list</span>);
    expect(() => render(<List of={set} />)).not.toThrow();
  });
});
