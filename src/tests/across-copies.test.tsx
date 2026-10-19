/**
 * A second copy of this package (Vite's SSR runner next to Node, or two bundles) must see the
 * same component registry. Each test loads a second copy of the modules with
 * `jest.isolateModulesAsync`, which gives that copy its own module registry: its own
 * `@_linked/react` and its own `@_linked/core`.
 */
import {describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {sharedStateKey} from '@_linked/core/utils/sharedState';
import * as copyA from '../package.js';
import {Person} from './fixtures.js';

type Registry = {shapeToComponents: Map<unknown, Set<unknown>>};

function registry(): Registry {
  const key = sharedStateKey('@_linked/react', 'componentRegistry');
  return (globalThis as unknown as Record<symbol, Registry>)[key];
}

async function loadCopyB(): Promise<{
  pkg: typeof copyA;
  fixtures: typeof import('./fixtures.js');
}> {
  let loaded: Awaited<ReturnType<typeof loadCopyB>> | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = {
      pkg: await import('../package.js'),
      fixtures: await import('./fixtures.js'),
    };
  });
  if (!loaded) throw new Error('second copy did not load');
  return loaded;
}

describe('component registry across copies', () => {
  test('the second copy is a separate module', async () => {
    const copyB = await loadCopyB();
    expect(copyB.pkg.linkedComponent).not.toBe(copyA.linkedComponent);
    expect(copyB.fixtures.Person).not.toBe(Person);
  });

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
