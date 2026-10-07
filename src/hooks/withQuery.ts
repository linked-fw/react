import type React from 'react';
import type {Shape} from '@_linked/core/shapes/Shape';
import type {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import {getShapeClass} from '@_linked/core/utils/ShapeClass';
import {getLiveQueryStore} from '@_linked/core/live/LiveQueryStore';
import {registerComponent} from '../package.js';

export type QueryComponent<C> = C & {query: QueryBuilder<any, any, any>; shape: typeof Shape};

/**
 * Give a hook-based component the same discovery a `linkedComponent` has:
 * `Component.query` and `Component.shape` for `preloadFor(Component)`, a
 * registration with the package registry, and a pinned template in the
 * live-query store (so `prepare()` lists it).
 */
export function withQuery<C extends React.ComponentType<any>>(
  component: C,
  query: QueryBuilder<any, any, any>,
  options: {name?: string} = {},
): QueryComponent<C> {
  const shapeIri = query.toJSON().shape;
  const shape = getShapeClass(shapeIri) as unknown as typeof Shape;
  if (!shape) {
    throw new Error(`withQuery(): no registered shape for ${shapeIri}`);
  }
  const named = component as QueryComponent<C>;
  named.query = query;
  named.shape = shape;
  getLiveQueryStore().template(query, {
    pinned: true,
    name: options.name ?? component.displayName ?? (component.name || undefined),
  });
  registerComponent(named as any, shape);
  return named;
}
