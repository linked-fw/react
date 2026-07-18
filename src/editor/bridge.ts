/**
 * Editor bridge runtime (iframe side) — arch-15 §3.3, plan-014 WP5 task 3.
 *
 * Runs inside the preview iframe. Translates between the DOM (stamped with
 * `data-plan-node`) and the editor shell: hit-test a point to a plan node,
 * measure a node's box, toggle the suspend-rerender hold during inline text
 * edits, and relay events to the parent shell.
 *
 * OD-9 (bridge home): kept in `@_linked/react` under `editor/` for now — no new
 * package to publish, and it needs the same React/DOM the runtime already has.
 * If it grows (gesture recognition, transform math), extract to
 * `@_linked/editor-bridge`; nothing here couples to that decision.
 */

import { PLAN_NODE_ATTR } from './stamp.js';
import { holdNode, releaseNode } from './holdRegistry.js';

export interface BridgeMessage {
  source: 'linked-editor-bridge';
  type: string;
  planNodeId?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface BridgeOptions {
  /** Where relayed events go. Default: `window.parent` (the editor shell). */
  post?: (msg: BridgeMessage) => void;
  /** DOM root to query. Default: `document`. */
  root?: Document | HTMLElement;
}

const selectorFor = (id: string) => `[${PLAN_NODE_ATTR}="${cssEscape(id)}"]`;

/** The plan node at a viewport point, or null. Walks up to the nearest stamp. */
export function hitTest(x: number, y: number, doc: Document = document): string | null {
  const el = doc.elementFromPoint(x, y) as Element | null;
  const stamped = el?.closest(`[${PLAN_NODE_ATTR}]`);
  return stamped?.getAttribute(PLAN_NODE_ATTR) ?? null;
}

/**
 * A node's bounding box in viewport coords. The stamp is `display: contents`
 * (no box of its own), so we union its element children's rects — the actual
 * painted content. Returns null when the node isn't in the DOM.
 */
export function boundingBox(
  planNodeId: string,
  root: Document | HTMLElement = document,
): DOMRect | null {
  const stamped = root.querySelector(selectorFor(planNodeId));
  if (!stamped) return null;
  const rects = Array.from(stamped.children).map((c) => c.getBoundingClientRect());
  const own = stamped.getBoundingClientRect();
  // If the stamp itself has a box (some layouts), prefer it; else union children.
  const boxes = own.width || own.height ? [own, ...rects] : rects;
  if (boxes.length === 0) return own; // nothing painted yet
  return unionRects(boxes);
}

/** Begin an inline text edit: hold the node so live data won't re-render it. */
export function beginTextEdit(planNodeId: string): void {
  holdNode(planNodeId);
}

/** End the edit: release the hold; the node resumes with current data. */
export function endTextEdit(planNodeId: string): void {
  releaseNode(planNodeId);
}

/** Create a bridge bound to a shell transport. */
export function createBridge(opts: BridgeOptions = {}) {
  const post =
    opts.post ??
    ((msg: BridgeMessage) => {
      if (typeof window !== 'undefined' && window.parent) {
        window.parent.postMessage(msg, '*');
      }
    });
  const root = opts.root ?? (typeof document !== 'undefined' ? document : undefined);
  const doc = root instanceof Document ? root : document;

  const relay = (type: string, planNodeId?: string): void => {
    const rect = planNodeId ? boundingBox(planNodeId, root ?? document) : null;
    post({
      source: 'linked-editor-bridge',
      type,
      planNodeId: planNodeId ?? undefined,
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined,
    });
  };

  return {
    hitTest: (x: number, y: number) => hitTest(x, y, doc),
    boundingBox: (id: string) => boundingBox(id, root ?? document),
    beginTextEdit,
    endTextEdit,
    /** Relay a hover/select to the shell (with the node's box). */
    relay,
  };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function unionRects(rects: DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  // Plain rect (avoid `new DOMRect` — not in every DOM/jsdom build).
  const w = right - left;
  const h = bottom - top;
  return {
    x: left, y: top, width: w, height: h,
    top, left, right, bottom,
    toJSON() { return { x: left, y: top, width: w, height: h }; },
  } as DOMRect;
}

/** Minimal CSS attribute-value escape (ids are base36, but be safe). */
function cssEscape(v: string): string {
  return v.replace(/["\\]/g, '\\$&');
}
