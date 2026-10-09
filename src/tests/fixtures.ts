/**
 * Shared test fixtures: a Team/Person model whose `name` properties share the
 * `schema:name` predicate, and a scripted dataset that answers from a row
 * table, records every fetch per query template, performs mutations and can
 * emit change events like a dataset with a change feed would.
 */
import {Shape} from '@_linked/core/shapes/Shape';
import {literalProperty, objectProperty} from '@_linked/core/shapes/SHACL';
import {ShapeSet} from '@_linked/core/collections/ShapeSet';
import {linkedPackage} from '@_linked/core/utils/Package';
import type {IDataset} from '@_linked/core/interfaces/IDataset';
import type {ChangeEvent} from '@_linked/core/live/changes';
import {templateKey} from '@_linked/core/live/keys';
import {xsd} from '@_linked/core/ontologies/xsd';
import {isContextRefJSON, resolveContextId, CONTEXT_REF_KEY} from '@_linked/core/queries/ContextRef';

const {linkedShape} = linkedPackage('react-test-fixtures');

const schemaName = {id: 'http://schema.org/name'};
const ex = (s: string) => ({id: `http://example.org/rt/${s}`});

@linkedShape
export class Person extends Shape {
  static targetClass = ex('class/Person');

  @literalProperty({path: schemaName, maxCount: 1})
  get name(): string {
    return '';
  }

  @literalProperty({path: ex('age'), datatype: xsd.integer, maxCount: 1})
  get age(): number {
    return 0;
  }

  @literalProperty({path: ex('email'), maxCount: 1})
  get email(): string {
    return '';
  }
}

@linkedShape
export class Team extends Shape {
  static targetClass = ex('class/Team');

  @literalProperty({path: schemaName, maxCount: 1})
  get name(): string {
    return '';
  }

  @objectProperty({path: ex('member'), shape: Person})
  get members(): ShapeSet<Person> {
    return null as any;
  }

  @objectProperty({path: ex('lead'), shape: Person, maxCount: 1})
  get lead(): Person {
    return null as any;
  }
}

export const ids = {
  T1: 'http://example.org/rt/entity/T1',
  P1: 'http://example.org/rt/entity/P1',
  P2: 'http://example.org/rt/entity/P2',
  P3: 'http://example.org/rt/entity/P3',
  P4: 'http://example.org/rt/entity/P4',
  P5: 'http://example.org/rt/entity/P5',
  P9: 'http://example.org/rt/entity/P9',
};

export type Row = {id: string; [key: string]: unknown};

type Deferred = {resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown>};

export class ScriptedDataset implements IDataset {
  rows = new Map<string, Row>();
  /** Fetches per query template key. */
  fetches = new Map<string, number>();
  selects = 0;
  /** Deferred answers consumed by the next selects, in order. */
  queue: Deferred[] = [];
  private listeners = new Set<(e: ChangeEvent) => void>();

  constructor(rows: Row[] = defaultRows()) {
    for (const r of rows) this.rows.set(r.id, r);
  }

  defer(): Deferred {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const d = {resolve, reject, promise};
    this.queue.push(d);
    return d;
  }

  fetchesOf(query: {toJSON(): unknown}): number {
    return this.fetches.get(templateKey(query as any)) ?? 0;
  }

  async selectQuery(query: any): Promise<any> {
    this.selects++;
    const key = templateKey(query);
    this.fetches.set(key, (this.fetches.get(key) ?? 0) + 1);
    if (this.queue.length) return this.queue.shift()!.promise;
    const json = query.toJSON();
    if (json.op === 'count') return [...this.rows.values()].filter((r) => r.id.includes(shapeHint(json.shape))).length;
    // A real dataset resolves `{@ctx}` references when it lowers the query.
    const subject = isContextRefJSON(json.subject) ? resolveContextId((json.subject as any)[CONTEXT_REF_KEY], false) : json.subject;
    if (subject) return this.project(this.rows.get(subject), json);
    const pool = json.subjects
      ? json.subjects.map((s: string) => this.rows.get(s)).filter(Boolean)
      : [...this.rows.values()].filter((r) => r.id.includes(shapeHint(json.shape)));
    const offset = json.offset ?? 0;
    const limit = json.limit ?? pool.length;
    return pool.slice(offset, offset + limit).map((r: Row) => this.project(r, json));
  }

  /** Keep only the top-level labels the query selects (plus id), so result ids mirror a real store. */
  private project(row: Row | undefined, json: any): Row | null {
    if (!row) return null;
    const labels = new Set<string>(['id']);
    for (const f of json.fields ?? []) {
      if (typeof f === 'string') labels.add(f.split('.')[0]);
      else if (f && typeof f === 'object') for (const k of Object.keys(f)) labels.add(k.split('.')[0]);
    }
    const out: Row = {id: row.id};
    for (const [k, v] of Object.entries(row)) if (labels.has(k)) out[k] = v;
    // `members.size()` projects a number under `members`; a plain `members` projection keeps the rows.
    const sizeField = (json.fields ?? []).find((f: any) => f && typeof f === 'object' && f.members?.aggregation);
    if (sizeField && Array.isArray(out.members)) out.members = out.members.length;
    return out;
  }

  async askQuery(query: any): Promise<boolean> {
    const json = query.toJSON();
    return typeof json.subject === 'string' ? this.rows.has(json.subject) : this.rows.size > 0;
  }

  async updateQuery(query: any): Promise<any> {
    const json = query.toJSON();
    const row = this.rows.get(json.targetId);
    const result: Row = {id: json.targetId};
    for (const [label, value] of Object.entries(json.data ?? {})) {
      if (value && typeof value === 'object' && ('@add' in (value as object) || '@remove' in (value as object))) {
        const v = value as {'@add'?: any[]; '@remove'?: string[]};
        const current = Array.isArray(row?.[label]) ? ([...(row![label] as Row[])] as Row[]) : [];
        const added = (v['@add'] ?? []).map((a: any) => (typeof a === 'string' ? {id: a} : a['@id'] ? {id: a['@id']} : a));
        const removed = (v['@remove'] ?? []).map((id: string) => ({id}));
        const next = [...current.filter((m) => !removed.some((r: Row) => r.id === m.id)), ...added.map((a: Row) => this.rows.get(a.id) ?? a)];
        if (row) row[label] = next;
        result[label] = {added, removed};
      } else {
        const plain = value && typeof value === 'object' && '@id' in (value as object) ? {id: (value as any)['@id']} : value;
        if (row) row[label] = plain;
        result[label] = plain;
      }
    }
    return result;
  }

  async createQuery(query: any): Promise<any> {
    const json = query.toJSON();
    const id = `http://example.org/rt/entity/new-${this.rows.size}`;
    const row: Row = {id, ...json.data};
    this.rows.set(id, row);
    return row;
  }

  async deleteQuery(query: any): Promise<any> {
    const json = query.toJSON();
    const deleted = (json.ids ?? []).map((id: string) => ({id}));
    for (const {id} of deleted) this.rows.delete(id);
    return {deleted, count: deleted.length};
  }

  subscribeChanges(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emit a change as a dataset with a feed would. */
  emit(event: ChangeEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

/** Rows are identified as Team/Person by their id prefix, enough for a scripted store. */
function shapeHint(shapeIri: string | undefined): string {
  return shapeIri?.endsWith('Team') ? '/T' : '/P';
}

export function defaultRows(): Row[] {
  const p = (id: string, name: string, age: number) => ({id, name, age, email: `${name.toLowerCase()}@x`});
  const P1 = p(ids.P1, 'Semmy', 30);
  const P2 = p(ids.P2, 'Moa', 28);
  const P3 = p(ids.P3, 'Jinx', 17);
  const P4 = p(ids.P4, 'Quinn', 40);
  const P5 = p(ids.P5, 'Rex', 22);
  const P9 = p(ids.P9, 'Zed', 50);
  return [P1, P2, P3, P4, P5, P9, {id: ids.T1, name: 'Core', members: [P1, P2], lead: {id: ids.P1}}];
}
