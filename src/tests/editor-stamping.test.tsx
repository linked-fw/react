import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';
import React, {useState} from 'react';
import {act, render} from '@testing-library/react';
import {setEditorBuild} from '../editor/editorBuild.js';
import {
  PLAN_NODE_ATTR,
  PlanNodeContext,
  resolvePlanNodeId,
  useEditorStamp,
} from '../editor/stamp.js';
import {holdNode, releaseNode, __resetHolds} from '../editor/holdRegistry.js';

/**
 * WP5 stamping + suspend-rerender — the two `React.createElement(functionalComponent)`
 * choke points call `useEditorStamp`. This exercises that hook directly (the
 * choke points are thin wrappers over it).
 */

// Mirrors the choke point: render `child`, stamped by the seam.
function Choke(props: Record<string, unknown> & {value?: string}) {
  const {stamp} = useEditorStamp(props);
  return <>{stamp(<div className="content">{props.value ?? 'x'}</div>)}</>;
}

beforeEach(() => __resetHolds());
afterEach(() => setEditorBuild(undefined));

describe('resolvePlanNodeId', () => {
  test('explicit data-plan-node prop wins over context', () => {
    expect(resolvePlanNodeId({[PLAN_NODE_ATTR]: 'p1'}, 'ctx')).toBe('p1');
  });
  test('planNodeId prop is accepted', () => {
    expect(resolvePlanNodeId({planNodeId: 'p2'}, undefined)).toBe('p2');
  });
  test('falls back to context', () => {
    expect(resolvePlanNodeId({}, 'ctx')).toBe('ctx');
  });
  test('undefined when neither', () => {
    expect(resolvePlanNodeId({}, undefined)).toBeUndefined();
  });
});

describe('data-plan-node stamping', () => {
  test('editor build ON: the DOM carries the plan-node attribute (display:contents)', () => {
    setEditorBuild(true);
    const {container} = render(<Choke {...{[PLAN_NODE_ATTR]: 'i2mv0'}} />);
    const stamped = container.querySelector(`[${PLAN_NODE_ATTR}="i2mv0"]`) as HTMLElement;
    expect(stamped).toBeTruthy();
    expect(stamped.style.display).toBe('contents');
    expect(stamped.querySelector('.content')?.textContent).toBe('x');
  });

  test('editor build OFF: no attribute, child rendered unwrapped', () => {
    setEditorBuild(false);
    const {container} = render(<Choke {...{[PLAN_NODE_ATTR]: 'i2mv0'}} />);
    expect(container.querySelector(`[${PLAN_NODE_ATTR}]`)).toBeNull();
    expect(container.querySelector('.content')?.textContent).toBe('x');
  });

  test('no resolvable id → not stamped even in an editor build', () => {
    setEditorBuild(true);
    const {container} = render(<Choke value="y" />);
    expect(container.querySelector(`[${PLAN_NODE_ATTR}]`)).toBeNull();
  });

  test('id can come from PlanNodeContext (a parent stamps its child)', () => {
    setEditorBuild(true);
    const {container} = render(
      <PlanNodeContext.Provider value="s3l89">
        <Choke />
      </PlanNodeContext.Provider>,
    );
    expect(container.querySelector(`[${PLAN_NODE_ATTR}="s3l89"]`)).toBeTruthy();
  });
});

describe('suspend-rerender (hold) seam', () => {
  test('a held node freezes its output; releasing resumes with current data', () => {
    setEditorBuild(true);
    const id = 'b12d1';

    // A component that re-renders with a new `value` via external state.
    let setValue!: (v: string) => void;
    function Host() {
      const [value, sv] = useState('v1');
      setValue = sv;
      return <Choke {...{[PLAN_NODE_ATTR]: id}} value={value} />;
    }
    const {container} = render(<Host />);
    const read = () => container.querySelector('.content')?.textContent;
    expect(read()).toBe('v1');

    // Begin edit → hold. A data update must NOT change the rendered output.
    act(() => holdNode(id));
    act(() => setValue('v2'));
    expect(read()).toBe('v1'); // frozen

    // End edit → release. The node resumes with the current data.
    act(() => releaseNode(id));
    expect(read()).toBe('v2');
  });

  test('holds are per-node — an unheld sibling still updates', () => {
    setEditorBuild(true);
    let setV!: (v: string) => void;
    function Host() {
      const [v, sv] = useState('a');
      setV = sv;
      return <Choke {...{[PLAN_NODE_ATTR]: 'other'}} value={v} />;
    }
    const {container} = render(<Host />);
    act(() => holdNode('unrelated'));
    act(() => setV('b'));
    expect(container.querySelector('.content')?.textContent).toBe('b'); // not held
  });
});
