/*
 * The component index (`componentIndexTurtle`): what `linked build` writes as
 * `lib/esm/data/components.ttl` from a package's `components/index` exports.
 */
import {describe, expect, test} from '@jest/globals';
import React from 'react';
import {QueryBuilder} from '@_linked/core/queries/QueryBuilder';
import {getQueryContext} from '@_linked/core/queries/QueryContext';
import {getPackageUri} from '@_linked/core/shapes/SHACL';
import {linkedComponent, linkedSetComponent} from '../package.js';
import {canonicalJson, componentIndexEntries, componentIndexTurtle} from '../utils/componentIndex.js';
import {Person, Team} from './fixtures.js';

const PKG = 'react-test-fixtures';
const PKG_IRI = getPackageUri(PKG);
const PERSON = Person.shape.id;
const TEAM = Team.shape.id;

const PersonCard = linkedComponent(Person.select((p) => [p.name, p.age]), ({name}) => <div>{name}</div>);
const PersonList = linkedSetComponent(Person.select((p) => p.name), ({sources}) => <ul>{sources.size}</ul>);
const TeamMembers = linkedSetComponent({members: Team.select((t) => t.name)}, () => <ul />);
const CurrentUser = linkedComponent(Person.select((p) => p.name).for(getQueryContext('user')), () => <div />);
const FixedPerson = linkedComponent(Person.select((p) => p.email).for('http://example.org/rt/entity/P1'), () => <div />);
const NoOne = linkedComponent(Person.select((p) => p.name).for(null), () => <div />);

const exports = {PersonCard, PersonList, TeamMembers};
const lines = (turtle: string) => turtle.split('\n');
/** The statement line of `subject` (one per subject, K8's fixed form). */
const lineOf = (turtle: string, subject: string) => lines(turtle).find((l) => l.startsWith(`<${subject}> `))!;
/** The object of `core:{name}` on `subject`'s line, as written. */
const objectOf = (turtle: string, subject: string, name: string) =>
  lineOf(turtle, subject).match(new RegExp(` core:${name} ((?:"(?:[^"\\\\]|\\\\.)*"(?:\\^\\^rdf:JSON)?)|<[^>]+>)`))?.[1];
/** A Turtle string literal's value. */
const unquote = (written: string) => JSON.parse(written.replace(/\^\^rdf:JSON$/, ''));

describe('componentIndexTurtle', () => {
  test('single and set components: types, IRIs, export names, shapes and canonical JSON', () => {
    const turtle = componentIndexTurtle(PKG, exports)!;
    expect(lines(turtle).slice(0, 4)).toEqual([
      '@prefix core: <https://linked.cm/ont/core/> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      '',
    ]);
    expect(turtle.endsWith('.\n')).toBe(true);
    const iri = (name: string) => `${PKG_IRI}/component/${name}`;
    expect(lines(turtle)[4]).toBe(
      `<${PKG_IRI}> core:definesComponent <${iri('PersonCard')}> , <${iri('PersonList')}> , <${iri('TeamMembers')}> .`,
    );
    const cardJson = canonicalJson(PersonCard.query.toJSON());
    expect(lines(turtle)[5]).toBe(
      `<${iri('PersonCard')}> a core:Component ; core:exportName "PersonCard" ; core:query ${JSON.stringify(cardJson)}^^rdf:JSON ; core:queryShape <${PERSON}> ; core:startShape <${PERSON}> .`,
    );
    expect(lines(turtle)[6]).toMatch(new RegExp(`^<${iri('PersonList')}> a core:Component , core:SetComponent ; `));
    expect(lines(turtle)).toHaveLength(9);

    expect(lineOf(turtle, iri('TeamMembers'))).toMatch(/ a core:Component , core:SetComponent ; /);
    // The set component's one-key wrapper is unwrapped: the query is Team's.
    const teamQuery = objectOf(turtle, iri('TeamMembers'), 'query')!;
    expect(teamQuery.endsWith('^^rdf:JSON')).toBe(true);
    expect(JSON.parse(unquote(teamQuery)).shape).toBe(TEAM);
    expect(objectOf(turtle, iri('TeamMembers'), 'startShape')).toBe(`<${TEAM}>`);
    expect(objectOf(turtle, iri('TeamMembers'), 'queryShape')).toBe(`<${TEAM}>`);
  });

  test('the query literal is canonical JSON: keys sorted at every level, no whitespace', () => {
    const entry = componentIndexEntries(PKG, {PersonCard})[0];
    expect(entry.query).not.toMatch(/\s/);
    const sortedEverywhere = (v: unknown): boolean =>
      Array.isArray(v)
        ? v.every(sortedEverywhere)
        : v !== null && typeof v === 'object'
          ? Object.keys(v).join() === Object.keys(v).sort().join() && Object.values(v).every(sortedEverywhere)
          : true;
    expect(sortedEverywhere(JSON.parse(entry.query))).toBe(true);
    expect(JSON.parse(entry.query)).toEqual(JSON.parse(JSON.stringify(PersonCard.query.toJSON())));
    expect(canonicalJson({b: 1, a: [{d: 1, c: 2}], 10: 'x', 2: 'y'})).toBe('{"10":"x","2":"y","a":[{"c":2,"d":1}],"b":1}');
  });

  test('a component exported under two names is one entry, named by the smallest', () => {
    const entries = componentIndexEntries(PKG, {Zed: PersonCard, Card: PersonCard, PersonCard});
    expect(entries.map((e) => e.exportName)).toEqual(['Card']);
  });

  test('plain functions, values and the default export are ignored', () => {
    const Plain = () => <div />;
    const entries = componentIndexEntries(PKG, {Plain, n: 1, s: 'x', nil: null, obj: {query: 1, shape: 2}, default: PersonList, PersonCard});
    expect(entries.map((e) => e.exportName)).toEqual(['PersonCard']);
  });

  test('queries bound at definition time serialize as written and fromJSON reads them back', () => {
    const entries = componentIndexEntries(PKG, {CurrentUser, FixedPerson, NoOne});
    const byName = Object.fromEntries(entries.map((e) => [e.exportName, JSON.parse(e.query)]));
    expect(byName.CurrentUser.subject).toEqual({'@ctx': 'user'});
    expect(byName.FixedPerson.subject).toBe('http://example.org/rt/entity/P1');
    expect(byName.NoOne.nullSubject).toBe(true);
    for (const e of entries) {
      expect(canonicalJson(QueryBuilder.fromJSON(JSON.parse(e.query)).toJSON())).toBe(e.query);
    }
  });

  test('a component whose query does not serialize is left out with a warning', () => {
    const broken = {
      query: Person.select(() => {
        throw new Error('no such property');
      }),
      shape: Person,
    };
    const warnings: string[] = [];
    const turtle = componentIndexTurtle(PKG, {Broken: broken, PersonCard}, warnings)!;
    expect(turtle).not.toContain('Broken');
    expect(turtle).toContain('PersonCard');
    expect(warnings).toEqual([expect.stringMatching(/^Broken: its query does not serialize \(.*no such property.*\)/)]);
  });

  test('the same components give the same bytes, whatever the export order', () => {
    const a = componentIndexTurtle(PKG, {PersonCard, PersonList, TeamMembers});
    const b = componentIndexTurtle(PKG, {TeamMembers, PersonList, PersonCard});
    expect(a).toBe(componentIndexTurtle(PKG, exports));
    expect(b).toBe(a);
  });

  test('no linked component: undefined', () => {
    expect(componentIndexTurtle(PKG, {})).toBeUndefined();
    expect(componentIndexTurtle(PKG, {Plain: () => null})).toBeUndefined();
  });

  test('an export name with non-ASCII characters is percent-encoded in the IRI', () => {
    const [entry] = componentIndexEntries(PKG, {Persoonskaartjé: PersonCard});
    expect(entry.iri).toBe(`${PKG_IRI}/component/Persoonskaartj%C3%A9`);
    expect(entry.exportName).toBe('Persoonskaartjé');
    const turtle = componentIndexTurtle(PKG, {Persoonskaartjé: PersonCard})!;
    expect(unquote(objectOf(turtle, entry.iri, 'exportName')!)).toBe('Persoonskaartjé');
  });

  test('linkedSetComponent marks its result; linkedComponent does not', () => {
    expect(PersonList.setComponent).toBe(true);
    expect(TeamMembers.setComponent).toBe(true);
    expect(PersonCard.setComponent).toBeUndefined();
  });
});
