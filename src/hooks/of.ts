import {Shape} from '@_linked/core/shapes/Shape';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {isNodeReferenceValue, type NodeReferenceValue} from '@_linked/core/utils/NodeReference';
import type {QResult} from '@_linked/core/queries/SelectQuery';
import type {QueryBuilder} from '@_linked/core/queries/QueryBuilder';

/** A result object: a node id plus whatever labels were selected. */
export type ResultObject = {id: string; [label: string]: unknown};
/** What a single-subject hook or component accepts as its subject. */
export type OfInput = NodeReferenceValue | Shape | QResult<any> | ResultObject | null | undefined;
/** What a set hook or component accepts as its subjects. */
export type SetOfInput =
  | ShapeSet<any>
  | ReadonlyArray<NodeReferenceValue | Shape | QResult<any> | ResultObject>
  | null
  | undefined;

/** The node id behind an `of` value, or `undefined` when there is none. */
export function subjectIdOf(of: OfInput): string | undefined {
  let input: unknown = of;
  // A one-element array (e.g. from `preloadFor` on a maxCount:1 property) is that element.
  if (Array.isArray(input) && input.length === 1) input = input[0];
  if (input instanceof Shape) return input.id;
  if (isNodeReferenceValue(input)) return (input as NodeReferenceValue).id;
  return undefined;
}

/** The node ids behind a set `of` value, or `undefined` for "all instances". */
export function subjectIdsOf(of: SetOfInput): string[] | undefined {
  if (!of) return undefined;
  const items = of instanceof ShapeSet ? Array.from(of) : Array.from(of as ReadonlyArray<unknown>);
  const ids: string[] = [];
  for (const item of items) {
    const id = subjectIdOf(item as OfInput);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Whether `of` already carries every label the query selects, so a component
 * can render from it without fetching (a parent preloaded it via `preloadFor`).
 * Only own properties count: a Shape instance has the labels as prototype
 * getters and must be fetched, not treated as data.
 */
export function isCompleteQResult(of: unknown, query: QueryBuilder<any>): of is QResult<any> {
  if (!of || typeof of !== 'object' || of instanceof Shape) return false;
  if (typeof (of as QResult<any>).id !== 'string') return false;
  const fieldSet = query.fields();
  if (!fieldSet) return false;
  return fieldSet.labels().every((label) => Object.prototype.hasOwnProperty.call(of, label));
}

export function isCompleteSetQResult(of: unknown, query: QueryBuilder<any>): of is QResult<any>[] {
  return Array.isArray(of) && of.length > 0 && of.every((item) => isCompleteQResult(item, query));
}

/** The own enumerable keys of `of` other than `shape`, forwarded to a component as before the live-query rewrite. */
export function ownPropsOf(of: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!of || typeof of !== 'object' || of instanceof Shape || Array.isArray(of)) return out;
  for (const key of Object.keys(of as object)) {
    if (key !== 'shape') out[key] = (of as Record<string, unknown>)[key];
  }
  return out;
}
