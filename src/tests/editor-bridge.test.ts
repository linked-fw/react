import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {
  hitTest,
  boundingBox,
  beginTextEdit,
  endTextEdit,
  createBridge,
  type BridgeMessage,
} from '../editor/bridge.js';
import {isHeld, __resetHolds} from '../editor/holdRegistry.js';
import {PLAN_NODE_ATTR} from '../editor/stamp.js';

/**
 * WP5 bridge runtime — hit-testing, boxing, text-edit holds, event relay.
 * jsdom has no layout, so geometry is presence/attribute-level, not pixels.
 */

beforeEach(() => {
  __resetHolds();
  document.body.innerHTML = '';
});
afterEach(() => {
  jest.restoreAllMocks();
  delete (document as {elementFromPoint?: unknown}).elementFromPoint;
});

// jsdom (this version) has no layout API — provide elementFromPoint directly.
function stubElementFromPoint(el: Element | null): void {
  (document as unknown as {elementFromPoint: (x: number, y: number) => Element | null}).elementFromPoint =
    () => el;
}

function mountStamped(id: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.setAttribute(PLAN_NODE_ATTR, id);
  wrap.style.display = 'contents';
  const child = document.createElement('div');
  child.className = 'content';
  child.textContent = 'hi';
  wrap.appendChild(child);
  document.body.appendChild(wrap);
  return child;
}

describe('hitTest', () => {
  test('walks up from the hovered element to the nearest stamp', () => {
    const child = mountStamped('i123');
    stubElementFromPoint(child);
    expect(hitTest(10, 10)).toBe('i123');
  });

  test('returns null when the point is over nothing stamped', () => {
    const loose = document.createElement('div');
    document.body.appendChild(loose);
    stubElementFromPoint(loose);
    expect(hitTest(0, 0)).toBeNull();
  });
});

describe('boundingBox', () => {
  test('returns a rect for a mounted node, null for an absent one', () => {
    mountStamped('i123');
    expect(boundingBox('i123')).not.toBeNull();
    expect(boundingBox('nope')).toBeNull();
  });
});

describe('text-edit holds', () => {
  test('beginTextEdit holds the node; endTextEdit releases it', () => {
    expect(isHeld('n1')).toBe(false);
    beginTextEdit('n1');
    expect(isHeld('n1')).toBe(true);
    endTextEdit('n1');
    expect(isHeld('n1')).toBe(false);
  });
});

describe('createBridge relay', () => {
  test('relays a typed message to the shell transport, with the node box', () => {
    mountStamped('i123');
    const posted: BridgeMessage[] = [];
    const bridge = createBridge({post: (m) => posted.push(m)});
    bridge.relay('hover', 'i123');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({source: 'linked-editor-bridge', type: 'hover', planNodeId: 'i123'});
    expect(posted[0].rect).toBeDefined();
  });

  test('hitTest via the bridge honors the same walk', () => {
    const child = mountStamped('i9');
    stubElementFromPoint(child);
    const bridge = createBridge({post: () => {}});
    expect(bridge.hitTest(5, 5)).toBe('i9');
  });
});
