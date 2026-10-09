import {describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import {render} from '@testing-library/react';

// The suite runs as native ESM, so the mock is registered before the dynamic
// imports below. `react-native` (a devDependency, Flow source) is replaced by
// plain string host types.
const reactNativeFactory = jest.fn(() => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
}));
jest.unstable_mockModule('react-native', reactNativeFactory);

// The order of the tests matters: the root barrel is checked before the native
// barrel is imported, because importing the native barrel installs its
// defaults on the shared `LinkedComponentDefaults` object.
describe('@_linked/react/native', () => {
  test('the root barrel keeps the SVG defaults and never loads react-native', async () => {
    const root = await import('@_linked/react');
    const {Shape} = await import('@_linked/core/shapes/Shape');
    const {literalProperty} = await import('@_linked/core/shapes/SHACL');
    const {LinkedStorage} = await import('@_linked/core/utils/LinkedStorage');

    expect(root.LinkedComponentDefaults.loader).toBeUndefined();
    expect(root.LinkedComponentDefaults.errorElement).toBeUndefined();
    expect(reactNativeFactory).not.toHaveBeenCalled();
    // The hooks and the live-query levers are part of the root API.
    expect(typeof root.useLinkedQuery).toBe('function');
    expect(typeof root.useLinkedSetQuery).toBe('function');
    expect(typeof root.invalidate).toBe('function');
    expect(typeof root.publishChange).toBe('function');

    // A query that never resolves keeps the component on the built-in loader.
    LinkedStorage.setDefaultDataset({
      selectQuery: () => new Promise(() => {}),
    } as any);

    @root.linkedShape
    class RootBarrelPerson extends Shape {
      static targetClass = {id: 'urn:test:native:RootBarrelPerson'};

      @literalProperty({path: {id: 'urn:test:native:name'}, maxCount: 1})
      get name(): string {
        return '';
      }
    }
    const Card = root.linkedComponent(
      RootBarrelPerson.select((p) => p.name),
      ({name}) => React.createElement('div', null, name),
    );

    const {container} = render(
      React.createElement(Card, {of: {id: 'urn:test:native:p1'}} as any),
    );
    expect(container.querySelector('svg.ld-loader')).not.toBeNull();
  });

  test('importing the native barrel installs React Native defaults', async () => {
    const native = await import('@_linked/react/native');

    expect(reactNativeFactory).toHaveBeenCalled();
    // Same API as the root entry.
    expect(typeof native.useLinkedQuery).toBe('function');
    expect(typeof native.useLinkedSetQuery).toBe('function');
    expect(typeof native.invalidate).toBe('function');

    const loader = native.LinkedComponentDefaults.loader as React.ReactElement<any>;
    expect(loader.type).toBe('ActivityIndicator');
    expect(loader.props.testID).toBe('linked-loader');

    const errorElement = native.LinkedComponentDefaults
      .errorElement as React.ReactElement<any>;
    expect(errorElement.type).toBe('Text');
    expect(errorElement.props.testID).toBe('linked-error');
    expect(errorElement.props.accessibilityRole).toBe('alert');
    expect(errorElement.props.children).toBe('Failed to load');

    const infinity = native.LinkedInfinityLoader() as React.ReactElement<any>;
    expect(infinity.type).toBe('ActivityIndicator');
  });

  test('the native barrel re-exports the root API by identity', async () => {
    const root = await import('@_linked/react');
    const native = await import('@_linked/react/native');

    expect(native.LinkedComponentDefaults).toBe(root.LinkedComponentDefaults);
    expect(native.linkedComponent).toBe(root.linkedComponent);
    expect(native.linkedSetComponent).toBe(root.linkedSetComponent);
    expect(native.linkedShape).toBe(root.linkedShape);
    expect(native.LinkedComponentClass).toBe(root.LinkedComponentClass);
    expect(native.useStyles).toBe(root.useStyles);
    expect(native.LinkedInfinityLoader).not.toBe(root.LinkedInfinityLoader);
  });
});
