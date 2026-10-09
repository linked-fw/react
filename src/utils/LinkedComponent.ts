import type {
  QResult,
  QueryResponseToResultType,
} from '@_linked/core/queries/SelectQuery';
import {Shape} from '@_linked/core/shapes/Shape';
import {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import type {FieldSet} from '@_linked/core/queries/FieldSet';
import {getLiveQueryStore} from '@_linked/core/live/LiveQueryStore';

import React, {useCallback} from 'react';
import {LinkedStorage} from '@_linked/core/utils/LinkedStorage';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {isNodeReferenceValue, NodeReferenceValue} from '@_linked/core/utils/NodeReference';
import {getShapeClass, hasSuperClass} from '@_linked/core/utils/ShapeClass';
import {useLinkedQuery} from '../hooks/useLinkedQuery.js';
import {useLinkedSetQuery} from '../hooks/useLinkedSetQuery.js';
import {isCompleteQResult, ownPropsOf} from '../hooks/of.js';

/**
 * Extract the Shape type parameter from a QueryBuilder.
 */
type GetQueryShapeType<Q> = Q extends QueryBuilder<infer S, any, any> ? S : never;

/**
 * Extract the query response type from a QueryBuilder or FieldSet.
 * Falls through to Q itself if neither matches (preserves legacy behaviour).
 */
type GetQueryResponseType<Q> =
  Q extends QueryBuilder<any, infer R, any> ? R :
  Q extends FieldSet<infer R, any> ? R :
  Q;

/**
 * A wrapper object mapping a single key to a QueryBuilder (used by linkedSetComponent).
 */
type QueryWrapperObject<ShapeType extends Shape = any> = {
  [key: string]: QueryBuilder<ShapeType>;
};

/**
 * Query-driven-component types — react-local. Core removed these from
 * SelectQuery as "dead" (commit 5ace0cf), but only react used them; they live
 * here now, same as `GetQueryResponseType`/`QueryWrapperObject` above.
 */
type QueryController = {
  nextPage: () => void;
  previousPage: () => void;
  setLimit: (limit: number) => void;
  setPage: (page: number) => void;
};
type QueryControllerProps = {
  query?: QueryController;
};
type ToQueryResultSet<T> =
  T extends FieldSet<infer ResponseType, any>
    ? QueryResponseToResultType<ResponseType>[]
    : null;
type GetCustomObjectKeys<T> = T extends QueryWrapperObject
  ? {
      [P in keyof T]: T[P] extends FieldSet<any, any>
        ? ToQueryResultSet<T[P]>
        : never;
    }
  : [];

type ProcessDataResultType<ShapeType extends Shape> = [
  typeof Shape,
  QueryBuilder<ShapeType>,
];

export type Component<P = any, ShapeType extends Shape = Shape> =
  | ClassComponent<P, ShapeType>
  | LinkedComponent<P, ShapeType>
  | LinkedSetComponent<P, ShapeType>;

export interface ClassComponent<P, ShapeType extends Shape = Shape>
  extends React.ComponentClass<P & LinkedComponentProps<ShapeType>> {
  props: P & LinkedComponentProps<ShapeType>;
  shape?: typeof Shape;
}

export interface LinkedComponent<
  P,
  ShapeType extends Shape = Shape,
  ResultType = any,
> extends React.FC<
    P & LinkedComponentInputProps<ShapeType> & React.ComponentPropsWithRef<any>
  > {
  original?: LinkableComponent<P, ShapeType>;
  query: QueryBuilder<any>;
  shape?: typeof Shape;
}

export interface LinkedSetComponent<
  P,
  ShapeType extends Shape = Shape,
  Res = any,
> extends React.FC<
    P &
      LinkedSetComponentInputProps<ShapeType> &
      React.ComponentPropsWithRef<any>
  > {
  original?: LinkableSetComponent<P, ShapeType>;
  query: QueryBuilder<any> | QueryWrapperObject<ShapeType>;
  shape?: typeof Shape;
}

export type LinkableComponent<P, ShapeType extends Shape = Shape> = React.FC<
  P & LinkedComponentProps<ShapeType>
>;

/**
 * Options accepted by both `linkedComponent` and `linkedSetComponent` at
 * definition time (3rd positional arg) and inside the config-object form.
 * `loader` replaces the framework's default loading element; `errorElement`
 * replaces the default error element. Pass the sentinel `'rethrow'` for
 * `errorElement` to let the error propagate to an external `<ErrorBoundary>`.
 */
export interface LinkedComponentOptions {
  loader?: React.ReactElement;
  errorElement?: React.ReactElement | 'rethrow';
  /** Rendered when a single-subject query answers `null`. Without one, the component renders with empty result props. */
  notFoundElement?: React.ReactElement;
  /** Registry name of the component's query template (defaults to the component's function name). */
  name?: string;
  /** `false` opts the component's query out of automatic refetching. */
  reactive?: boolean;
}

/**
 * Config-object form of the factory:
 *   linkedComponent({ query, component, loader, errorElement });
 */
export interface LinkedComponentConfig<Q, P, ShapeType extends Shape = Shape>
  extends LinkedComponentOptions {
  query: Q;
  component: LinkableComponent<P, ShapeType>;
}

export interface LinkedSetComponentConfig<
  Q,
  P,
  ShapeType extends Shape = Shape,
> extends LinkedComponentOptions {
  query: Q;
  component: LinkableSetComponent<P, ShapeType>;
}

/**
 * App-global override for loader and errorElement. Setting either of these
 * applies to every `linkedComponent` / `linkedSetComponent` that doesn't
 * specify its own. Resolution order:
 *   instance prop > definition options > LinkedComponentDefaults > built-in
 */
export const LinkedComponentDefaults: {
  loader: React.ReactElement | undefined;
  errorElement: React.ReactElement | 'rethrow' | undefined;
  notFoundElement: React.ReactElement | undefined;
} = {
  loader: undefined,
  errorElement: undefined,
  notFoundElement: undefined,
};
export type LinkableSetComponent<
  P,
  ShapeType extends Shape = Shape,
  DataResultType = any,
> = React.FC<LinkedSetComponentProps<ShapeType, DataResultType> & P>;

export interface LinkedSetComponentProps<
  ShapeType extends Shape,
  DataResultType = any,
> extends LinkedComponentBaseProps<DataResultType>,
    QueryControllerProps {
  sources: ShapeSet<ShapeType>;
}

export interface LinkedComponentProps<ShapeType extends Shape>
  extends LinkedComponentBaseProps {
  source: ShapeType;
  _refresh: (updatedProps?: any) => void;
}

interface LinkedComponentBaseProps<DataResultType = any>
  extends React.PropsWithChildren {
  linkedData?: DataResultType;
  /** True while a refetch is in flight and the current data is still rendered. */
  _refreshing?: boolean;
  /** Rerun the query (`_refresh()`) or patch the result props locally (`_refresh({...})`). */
  _refresh?: (updatedProps?: any) => void;
}

export interface LinkedSetComponentInputProps<ShapeType extends Shape = Shape>
  extends LinkedComponentInputBaseProps {
  of?: ShapeSet<ShapeType> | QResult<ShapeType>[];
}

export interface LinkedComponentInputProps<ShapeType extends Shape = Shape>
  extends LinkedComponentInputBaseProps {
  of: NodeReferenceValue | ShapeType | QResult<ShapeType>;
}

interface LinkedComponentInputBaseProps extends React.PropsWithChildren {
  className?: string | string[];
  style?: React.CSSProperties;
  // Per-instance override of the loading element. Falls through to the
  // factory's `options.loader`, then `LinkedComponentDefaults.loader`,
  // then the built-in `<svg class="ld-loader" />`.
  loader?: React.ReactElement;
  // Per-instance override of the error element shown when the query fails.
  // Pass the sentinel `'rethrow'` to skip the internal error boundary and
  // let an external `<ErrorBoundary>` catch the error.
  errorElement?: React.ReactElement | 'rethrow';
  // Per-instance override of the element shown when a single-subject query
  // answers `null`.
  notFoundElement?: React.ReactElement;
}

export type LinkedSetComponentFactoryFn = <
  QueryType extends
    | QueryBuilder<any>
    | {[key: string]: QueryBuilder<any>} = null,
  CustomProps = {},
  ShapeType extends Shape = GetQueryShapeType<QueryType>,
  Res = ToQueryResultSet<QueryType>,
>(
  requiredData: QueryType,
  functionalComponent: LinkableSetComponent<
    CustomProps & GetCustomObjectKeys<QueryType> & QueryControllerProps,
    ShapeType,
    Res
  >,
) => LinkedSetComponent<CustomProps, ShapeType, Res>;

export type LinkedComponentFactoryFn = <
  QueryType extends QueryBuilder<any> = null,
  CustomProps = {},
  ShapeType extends Shape = GetQueryShapeType<QueryType>,
  Response = GetQueryResponseType<QueryType>,
  ResultType = QueryResponseToResultType<Response, ShapeType>,
>(
  query: QueryType,
  functionalComponent: LinkableComponent<CustomProps & ResultType, ShapeType>,
) => LinkedComponent<CustomProps, ShapeType, ResultType>;

export function createLinkedComponentFn(
  registerPackageExport,
  registerComponent,
) {
  function linkedComponent<
    QueryType extends QueryBuilder<any> = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = GetQueryResponseType<QueryType>,
  >(
    query: QueryType,
    functionalComponent: LinkableComponent<
      CustomProps & QueryResponseToResultType<Res, ShapeType>,
      ShapeType
    >,
  ): LinkedComponent<CustomProps, ShapeType, Res>;
  function linkedComponent<
    QueryType extends QueryBuilder<any> = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = GetQueryResponseType<QueryType>,
  >(
    query: QueryType,
    functionalComponent: LinkableComponent<
      CustomProps & QueryResponseToResultType<Res, ShapeType>,
      ShapeType
    >,
    options: LinkedComponentOptions,
  ): LinkedComponent<CustomProps, ShapeType, Res>;
  function linkedComponent<
    QueryType extends QueryBuilder<any> = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = GetQueryResponseType<QueryType>,
  >(
    config: LinkedComponentConfig<
      QueryType,
      CustomProps & QueryResponseToResultType<Res, ShapeType>,
      ShapeType
    >,
  ): LinkedComponent<CustomProps, ShapeType, Res>;
  function linkedComponent<
    QueryType extends QueryBuilder<any> = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = GetQueryResponseType<QueryType>,
  >(
    arg1: any,
    arg2?: any,
    arg3?: LinkedComponentOptions,
  ): LinkedComponent<CustomProps, ShapeType, Res> {
    const normalized = normalizeFactoryArgs<QueryType, CustomProps, ShapeType>(
      arg1,
      arg2,
      arg3,
    );
    const query = normalized.query;
    const functionalComponent =
      normalized.component as LinkableComponent<CustomProps, ShapeType>;
    const options = normalized.options;

    let [shapeClass, actualQuery] = processQuery<ShapeType>(query);
    const templateName = options.name ?? functionalComponent.name ?? undefined;
    // Pinned: the template stays registered (and listed by `prepare()`) even
    // while no instance of this component is mounted.
    getLiveQueryStore().template(actualQuery, {
      pinned: true,
      name: templateName || undefined,
      reactive: options.reactive,
    });

    let _wrappedComponent: LinkedComponent<CustomProps, ShapeType> =
      React.forwardRef<any, CustomProps & LinkedComponentInputProps<ShapeType>>(
        (props, ref) => {
          // Framework-only input props never reach the wrapped component.
          const {
            of,
            loader: instanceLoader,
            errorElement: instanceErrorElement,
            notFoundElement: instanceNotFoundElement,
            ...rest
          } = props as any;

          const source = getSourceFromInputProps(props, shapeClass);
          // A query bound at definition time (`.for(id)` / `.for(getQueryContext(…))`)
          // needs no `of`; a pending context serialises as a `{@ctx}` subject and
          // the store keeps the instance pending until it lands.
          const hasSubject = !!source || actualQuery.toJSON().subject !== undefined;
          const preloaded = isCompleteQResult(of, actualQuery);
          const usingStorage = LinkedStorage.isInitialised();

          // The hook owns the preloaded-child transition: `patch` edits a local
          // copy, `refresh` goes live, both reset when the subject changes.
          const live = useLinkedQuery(actualQuery, source ? {id: source.id} : undefined, {
            enabled: hasSubject,
            name: templateName || undefined,
            reactive: options.reactive,
          });
          const {refresh, patch, data} = live;
          const _refresh = useCallback(
            (updatedProps?: any) => (updatedProps ? patch(updatedProps) : void refresh()),
            [refresh, patch],
          );

          if (!hasSubject && !preloaded) {
            console.warn(
              'This component requires a source to be provided (use the property "of"): ' +
                functionalComponent.name,
            );
            return null;
          }

          if (live.error) {
            const resolved = resolveErrorElement(instanceErrorElement, options.errorElement);
            if (resolved === 'rethrow') {
              throw live.error;
            }
            return resolved;
          }

          if (data === null) {
            const notFound = resolveNotFoundElement(instanceNotFoundElement, options.notFoundElement);
            if (notFound) return notFound;
          }

          // Keep the legacy client-side guard to avoid hydration drift: the
          // server always renders the loader. Without storage there is nothing
          // to wait for: render with whatever `of` carried (legacy behaviour).
          const dataIsLoaded = data !== undefined || !usingStorage;
          if (!dataIsLoaded || typeof window === 'undefined') {
            return resolveLoader(instanceLoader, options.loader);
          }

          // Own keys of `of` are forwarded (a partial result object may carry
          // more than the query selects); the fetched result wins.
          const linkedProps: any = {
            ...rest,
            source,
            ...ownPropsOf(of),
            ...((data as Record<string, unknown> | null) ?? {}),
            _refresh,
            _refreshing: live.refreshing,
          };
          if (ref) {
            linkedProps.ref = ref;
          }
          return React.createElement(functionalComponent, linkedProps);
        },
      ) as any;

    _wrappedComponent.original = functionalComponent;
    _wrappedComponent.query = query;
    _wrappedComponent.shape = shapeClass;
    if (functionalComponent.name) {
      Object.defineProperty(_wrappedComponent, 'name', {
        value: functionalComponent.name,
      });
      registerPackageExport(_wrappedComponent);
    }

    registerComponent(_wrappedComponent, shapeClass);

    return _wrappedComponent;
  }

  return linkedComponent;
}

export function createLinkedSetComponentFn(
  registerPackageExport,
  registerComponent,
) {
  function linkedSetComponent<
    QueryType extends
      | QueryBuilder<any>
      | {[key: string]: QueryBuilder<any>} = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = ToQueryResultSet<QueryType>,
  >(
    query: QueryType,
    functionalComponent: LinkableSetComponent<
      CustomProps & GetCustomObjectKeys<QueryType> & QueryControllerProps,
      ShapeType
    >,
  ): LinkedSetComponent<CustomProps, ShapeType, Res>;
  function linkedSetComponent<
    QueryType extends
      | QueryBuilder<any>
      | {[key: string]: QueryBuilder<any>} = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = ToQueryResultSet<QueryType>,
  >(
    query: QueryType,
    functionalComponent: LinkableSetComponent<
      CustomProps & GetCustomObjectKeys<QueryType> & QueryControllerProps,
      ShapeType
    >,
    options: LinkedComponentOptions,
  ): LinkedSetComponent<CustomProps, ShapeType, Res>;
  function linkedSetComponent<
    QueryType extends
      | QueryBuilder<any>
      | {[key: string]: QueryBuilder<any>} = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = ToQueryResultSet<QueryType>,
  >(
    config: LinkedSetComponentConfig<
      QueryType,
      CustomProps & GetCustomObjectKeys<QueryType> & QueryControllerProps,
      ShapeType
    >,
  ): LinkedSetComponent<CustomProps, ShapeType, Res>;
  function linkedSetComponent<
    QueryType extends
      | QueryBuilder<any>
      | {[key: string]: QueryBuilder<any>} = null,
    CustomProps = {},
    ShapeType extends Shape = GetQueryShapeType<QueryType>,
    Res = ToQueryResultSet<QueryType>,
  >(
    arg1: any,
    arg2?: any,
    arg3?: LinkedComponentOptions,
  ): LinkedSetComponent<CustomProps, ShapeType, Res> {
    const normalized = normalizeFactoryArgs<QueryType, CustomProps, ShapeType>(
      arg1,
      arg2,
      arg3,
    );
    const query = normalized.query;
    const functionalComponent =
      normalized.component as LinkableSetComponent<CustomProps, ShapeType>;
    const options = normalized.options;

    let [shapeClass, actualQuery] = processQuery<ShapeType>(query as any, true);
    const templateName = options.name ?? functionalComponent.name ?? undefined;
    getLiveQueryStore().template(actualQuery, {
      pinned: true,
      name: templateName || undefined,
      reactive: options.reactive,
    });

    let _wrappedComponent: LinkedSetComponent<CustomProps, ShapeType, Res> =
      React.forwardRef<
        any,
        CustomProps & LinkedSetComponentInputProps<ShapeType>
      >((props, ref) => {
        const {
          of,
          loader: instanceLoader,
          errorElement: instanceErrorElement,
          notFoundElement: _ignoredNotFound,
          ...rest
        } = props as any;

        // Validates `of` (throws on anything but a ShapeSet / array) and
        // derives `sources`.
        const {sources} = getLinkedSetComponentProps<ShapeType, any>(props, shapeClass, functionalComponent);
        const usingStorage = LinkedStorage.isInitialised();

        const live = useLinkedSetQuery(actualQuery, of, {
          name: templateName || undefined,
          reactive: options.reactive,
        });
        const {refresh, patch, data} = live;
        const _refresh = useCallback(
          (updatedProps?: any) => (updatedProps ? patch(updatedProps) : void refresh()),
          [refresh, patch],
        );

        if (live.error) {
          const resolved = resolveErrorElement(instanceErrorElement, options.errorElement);
          if (resolved === 'rethrow') {
            throw live.error;
          }
          return resolved;
        }

        const dataIsLoaded = data !== undefined || !usingStorage;
        if (!dataIsLoaded) {
          return resolveLoader(instanceLoader, options.loader);
        }

        const linkedProps: any = {...rest, sources, _refresh, _refreshing: live.refreshing};
        if (data !== undefined) {
          if (query instanceof QueryBuilder) {
            linkedProps.linkedData = data;
          } else {
            linkedProps[Object.keys(query)[0]] = data;
          }
        }
        if (live.page.limit) {
          linkedProps.query = {
            nextPage: () => live.page.next(),
            previousPage: () => live.page.previous(),
            setLimit: (newLimit: number) => live.page.setLimit(newLimit),
            setPage: (page: number) => live.page.set(page),
          } as QueryController;
        }
        if (ref) {
          linkedProps.ref = ref;
        }
        return React.createElement(functionalComponent, linkedProps);
      }) as any;

    _wrappedComponent.original = functionalComponent;
    _wrappedComponent.query = query;

    _wrappedComponent.shape = shapeClass;
    if (functionalComponent.name) {
      Object.defineProperty(_wrappedComponent, 'name', {
        value: functionalComponent.name,
      });
      registerPackageExport(_wrappedComponent);
    }

    registerComponent(_wrappedComponent, shapeClass);

    return _wrappedComponent;
  }

  return linkedSetComponent;
}

function processQuery<ShapeType extends Shape>(
  requiredData: QueryBuilder<ShapeType> | QueryWrapperObject<ShapeType>,
  setComponent: boolean = false,
): ProcessDataResultType<ShapeType> {
  let shapeClass: typeof Shape;
  let query: QueryBuilder<ShapeType>;

  if (requiredData instanceof QueryBuilder) {
    query = requiredData;
    // QueryBuilder._shape is private; extract shape IRI via toJSON and resolve the class.
    shapeClass = getShapeClass(requiredData.toJSON().shape) as unknown as typeof Shape;
  } else if (typeof requiredData === 'object' && setComponent) {
    if (Object.keys(requiredData).length > 1) {
      throw new Error(
        'Only one key is allowed to map a query to a property for linkedSetComponents',
      );
    }
    for (let key in requiredData) {
      if (requiredData[key] instanceof QueryBuilder) {
        shapeClass = getShapeClass(requiredData[key].toJSON().shape) as unknown as typeof Shape;
        query = requiredData[key];
      } else {
        throw new Error(
          'Unknown value type for query object. Keep to this format: {propName: Shape.select(s => ...)}',
        );
      }
    }
  } else {
    throw new Error(
      'Unknown data query type. Expected a QueryBuilder (from Shape.select()) or an object with 1 key whose value is a QueryBuilder',
    );
  }
  return [shapeClass, query];
}

function getLinkedSetComponentProps<ShapeType extends Shape, P>(
  props: LinkedSetComponentInputProps<ShapeType>,
  shapeClass,
  functionalComponent,
): LinkedSetComponentProps<ShapeType> & P {
  if (
    props.of &&
    !(props.of instanceof ShapeSet) &&
    !Array.isArray(props.of)
  ) {
    throw Error(
      "Invalid argument 'of' provided to " +
        functionalComponent.name.replace('_implementation', '') +
        ' component: ' +
        props.of +
        '. Make sure to provide a ShapeSet, an array of QResults, or no argument at all to load all instances.',
    );
  }

  let sources: ShapeSet<ShapeType>;
  if (props.of instanceof ShapeSet) {
    sources = props.of;
  } else if (Array.isArray(props.of)) {
    sources = new ShapeSet(
      props.of.map((item) => {
        return getSourceFromInputProps({of: item}, shapeClass);
      }),
    );
  }

  const newProps = {
    ...props,
    sources,
  };

  delete (newProps as any).of;
  return newProps as LinkedSetComponentProps<ShapeType> & P;
}

export function getSourceFromInputProps(props, shapeClass) {
  let input = props?.of;

  // Unwrap single-element arrays (e.g. from preloadFor on maxCount:1 properties
  // where the result mapper returns an array with one item).
  if (Array.isArray(input) && input.length === 1) {
    input = input[0];
  }

  if (input instanceof Shape) {
    if (
      input.nodeShape !== shapeClass.shape &&
      !hasSuperClass(input.nodeShape.id, shapeClass)
    ) {
      return new shapeClass(input.id);
    }
    return input;
  }

  if (isNodeReferenceValue(input)) {
    return new shapeClass(input);
  }

  // If nothing is provided, keep undefined; callers handle required source checks.
  return input;
}

/**
 * Built-in loading element used when nothing higher in the resolution chain
 * sets one. Renders an SVG ring; `stroke: currentColor` lets parent context
 * tint it. Style via `.ld-loader` in `@_linked/css/loader.css`.
 */
function createDefaultLoader(): React.ReactElement {
  return React.createElement(
    'svg',
    {
      className: 'ld-loader',
      'aria-label': 'Loading',
      role: 'status',
      viewBox: '0 0 24 24',
      xmlns: 'http://www.w3.org/2000/svg',
    },
    React.createElement('circle', {
      className: 'ld-loader__track',
      cx: 12,
      cy: 12,
      r: 9,
      fill: 'none',
      stroke: 'currentColor',
    }),
    React.createElement('circle', {
      className: 'ld-loader__arc',
      cx: 12,
      cy: 12,
      r: 9,
      fill: 'none',
      stroke: 'currentColor',
    }),
  );
}

/**
 * Built-in error element used when a query rejects and nothing higher in the
 * resolution chain handles it. Renders a small cross SVG; styled by
 * `.ld-error` in `@_linked/css/error.css`.
 */
function createDefaultError(): React.ReactElement {
  return React.createElement(
    'svg',
    {
      className: 'ld-error',
      'aria-label': 'Failed to load',
      role: 'alert',
      viewBox: '0 0 24 24',
      xmlns: 'http://www.w3.org/2000/svg',
    },
    React.createElement('line', {
      x1: 6,
      y1: 6,
      x2: 18,
      y2: 18,
      stroke: 'currentColor',
    }),
    React.createElement('line', {
      x1: 18,
      y1: 6,
      x2: 6,
      y2: 18,
      stroke: 'currentColor',
    }),
  );
}

function resolveLoader(
  instanceLoader: React.ReactElement | undefined,
  definitionLoader: React.ReactElement | undefined,
): React.ReactElement {
  return (
    instanceLoader ??
    definitionLoader ??
    LinkedComponentDefaults.loader ??
    createDefaultLoader()
  );
}

/**
 * Resolves the error element. Returns either a React element to render, or
 * the literal `'rethrow'` — callers must rethrow the captured error when
 * they receive the sentinel.
 */
function resolveErrorElement(
  instanceErrorElement: React.ReactElement | 'rethrow' | undefined,
  definitionErrorElement: React.ReactElement | 'rethrow' | undefined,
): React.ReactElement | 'rethrow' {
  return (
    instanceErrorElement ??
    definitionErrorElement ??
    LinkedComponentDefaults.errorElement ??
    createDefaultError()
  );
}

/** Resolves the not-found element; `undefined` means "render the component with empty result props". */
function resolveNotFoundElement(
  instanceElement: React.ReactElement | undefined,
  definitionElement: React.ReactElement | undefined,
): React.ReactElement | undefined {
  return instanceElement ?? definitionElement ?? LinkedComponentDefaults.notFoundElement;
}

/**
 * Normalizes the three factory signatures into a single shape:
 *   (query, fn)                  -> { query, component: fn, options: {} }
 *   (query, fn, options)         -> { query, component: fn, options }
 *   ({ query, component, ... })  -> { query, component, options: { loader, errorElement } }
 */
function normalizeFactoryArgs<Q, P, S extends Shape>(
  arg1: Q | LinkedComponentConfig<Q, P, S> | LinkedSetComponentConfig<Q, P, S>,
  arg2?: LinkableComponent<P, S> | LinkableSetComponent<P, S>,
  arg3?: LinkedComponentOptions,
): {
  query: Q;
  component: LinkableComponent<P, S> | LinkableSetComponent<P, S>;
  options: LinkedComponentOptions;
} {
  if (
    arg2 === undefined &&
    arg1 &&
    typeof arg1 === 'object' &&
    'component' in (arg1 as any) &&
    'query' in (arg1 as any)
  ) {
    const config = arg1 as LinkedComponentConfig<Q, P, S> &
      LinkedSetComponentConfig<Q, P, S>;
    const {query, component, ...options} = config;
    return {query, component, options};
  }
  return {
    query: arg1 as Q,
    component: arg2 as LinkableComponent<P, S> | LinkableSetComponent<P, S>,
    options: arg3 ?? {},
  };
}
