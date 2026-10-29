/**
 * The component index of a package: per linked component its package exports from
 * `components/index`, the export name, the start shape, the query's shape and the query in the
 * wire format. `linked build` writes it as `lib/esm/data/components.ttl` by calling
 * {@link componentIndexTurtle} in a child process that has loaded the built package; a host (Create
 * Now) stores the file's triples as they are and hashes its bytes, so the text is fixed: the same
 * components give the same bytes, whatever the export order.
 */
import {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import {isLinkedInstance} from '@_linked/core/utils/linkedError';
import {getPackageUri} from '@_linked/core/shapes/SHACL';
import {coreOntology, ns as coreNs} from '@_linked/core/ontologies/linked-core';
import {rdf, ns as rdfNs} from '@_linked/core/ontologies/rdf';

export interface ComponentIndexEntry {
  /** `{package IRI}/component/{encodeURIComponent(exportName)}`. */
  iri: string;
  /** The code-point-smallest name the component is exported under. */
  exportName: string;
  /** Made by `linkedSetComponent`. */
  set: boolean;
  /** The node shape IRI of the component's `.shape`. */
  startShape: string;
  /** The `shape` of the query's wire format. */
  queryShape: string;
  /** The query's wire format (`QueryBuilder.toJSON()`) as canonical JSON. */
  query: string;
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PREFIXES: [string, string][] = [
  ['core', coreNs('').id],
  ['rdf', rdfNs('').id],
  ['xsd', XSD],
];

/** Order by Unicode code point (`<` on strings compares UTF-16 code units). */
const byCodePoint = (a: string, b: string): number => {
  const ca = Array.from(a);
  const cb = Array.from(b);
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const d = ca[i].codePointAt(0)! - cb[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
};

/** JSON with object keys sorted (recursively), arrays in order and no whitespace. */
export const canonicalJson = (value: unknown): string => {
  const write = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      const keys = Object.keys(record).sort(byCodePoint);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(record[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  };
  // Through JSON first: drops undefined members and functions, applies `toJSON` methods.
  return write(JSON.parse(JSON.stringify(value)));
};

const turtleString = (s: string): string =>
  `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;

const turtleIri = (iri: string): string => {
  for (const [prefix, base] of PREFIXES) {
    const local = iri.startsWith(base) ? iri.slice(base.length) : undefined;
    if (local && /^[A-Za-z][A-Za-z0-9_-]*$/.test(local)) return `${prefix}:${local}`;
  }
  return `<${iri}>`;
};

type ComponentLike = {query?: unknown; shape?: {shape?: {id?: string}}; setComponent?: boolean};

/** A linked component's query builder: `.query`, or the one value of a set component's wrapper. */
const queryOf = (component: ComponentLike): QueryBuilder<any> | undefined => {
  const q = component.query;
  if (isLinkedInstance(q, QueryBuilder)) return q;
  if (q && typeof q === 'object') {
    const values = Object.values(q as Record<string, unknown>);
    if (values.length === 1 && isLinkedInstance(values[0], QueryBuilder)) return values[0];
  }
  return undefined;
};

const isComponentLike = (value: unknown): value is ComponentLike =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  'query' in (value as object) &&
  'shape' in (value as object);

/**
 * The index entries of the linked components among `moduleExports` (the named exports of a
 * package's `components/index`), sorted by IRI. A component exported under several names is one
 * entry. Exports that are not linked components are ignored. A component whose query does not
 * serialize, or whose shape has no node shape, is left out, with a line in `warnings`.
 */
export function componentIndexEntries(
  packageName: string,
  moduleExports: Record<string, unknown>,
  warnings: string[] = [],
): ComponentIndexEntry[] {
  const nameOf = new Map<ComponentLike, string>();
  for (const name of Object.keys(moduleExports).sort(byCodePoint)) {
    const value = moduleExports[name];
    if (name === 'default' || !isComponentLike(value) || nameOf.has(value)) continue;
    if (!queryOf(value)) continue;
    nameOf.set(value, name);
  }

  const packageIri = getPackageUri(packageName);
  const entries: ComponentIndexEntry[] = [];
  for (const [component, exportName] of nameOf) {
    const startShape = component.shape?.shape?.id;
    if (!startShape) {
      warnings.push(`${exportName}: its shape has no node shape, left out of the component index`);
      continue;
    }
    let json: {shape?: string};
    try {
      json = queryOf(component)!.toJSON();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`${exportName}: its query does not serialize (${message}), left out of the component index`);
      continue;
    }
    if (!json.shape) {
      warnings.push(`${exportName}: its query names no shape, left out of the component index`);
      continue;
    }
    entries.push({
      iri: `${packageIri}/component/${encodeURIComponent(exportName)}`,
      exportName,
      set: component.setComponent === true,
      startShape,
      queryShape: json.shape,
      query: canonicalJson(json),
    });
  }
  return entries.sort((a, b) => byCodePoint(a.iri, b.iri));
}

/**
 * The component index as Turtle in its fixed form, or `undefined` when `moduleExports` holds no
 * linked component: one prefix block (`core`, `rdf`, `xsd`), the package's `core:definesComponent`
 * line, then one line per component sorted by IRI, `a` first and the other predicates sorted. No
 * blank nodes, no hash. Warnings as {@link componentIndexEntries}.
 */
export function componentIndexTurtle(
  packageName: string,
  moduleExports: Record<string, unknown>,
  warnings: string[] = [],
): string | undefined {
  const entries = componentIndexEntries(packageName, moduleExports, warnings);
  if (entries.length === 0) return undefined;
  const t = turtleIri;
  const lines = PREFIXES.map(([prefix, base]) => `@prefix ${prefix}: <${base}> .`);
  lines.push('');
  lines.push(
    `${t(getPackageUri(packageName))} ${t(coreOntology.definesComponent.id)} ${entries
      .map((e) => t(e.iri))
      .join(' , ')} .`,
  );
  for (const e of entries) {
    const types = [coreOntology.Component.id, ...(e.set ? [coreOntology.SetComponent.id] : [])]
      .sort(byCodePoint)
      .map(t)
      .join(' , ');
    const predicates: [string, string][] = [
      [coreOntology.exportName.id, turtleString(e.exportName)],
      [coreOntology.query.id, `${turtleString(e.query)}^^${t(rdf.JSON.id)}`],
      [coreOntology.queryShape.id, t(e.queryShape)],
      [coreOntology.startShape.id, t(e.startShape)],
    ];
    predicates.sort((a, b) => byCodePoint(a[0], b[0]));
    lines.push(
      `${t(e.iri)} a ${types} ; ${predicates.map(([p, o]) => `${t(p)} ${o}`).join(' ; ')} .`,
    );
  }
  return lines.join('\n') + '\n';
}
