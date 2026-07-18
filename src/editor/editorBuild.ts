/**
 * Editor-build flag — CN visual builder, plan-014 WP5 task 1.
 *
 * Whether this is an EDITOR build: branch previews and the `main` deployment's
 * CMS-mode edits stamp plan-node ids and enable the bridge; published builds do
 * NOT (zero overhead, no stamping). This is a BUILD-TIME decision, deliberately
 * NOT `NODE_ENV` — a production branch-preview is `NODE_ENV=production` but is
 * still an editor build, and a published site is production and is not.
 *
 * Resolution order: an explicit `setEditorBuild()` (tests / runtime override)
 * wins; else the build-time global `__LINKED_EDITOR_BUILD__` a bundler defines
 * (e.g. Vite `define`); else `process.env.LINKED_EDITOR_BUILD === '1'`; else off.
 */

let override: boolean | undefined;

declare const __LINKED_EDITOR_BUILD__: boolean | undefined;

export function isEditorBuild(): boolean {
  if (override !== undefined) return override;
  try {
    if (typeof __LINKED_EDITOR_BUILD__ !== 'undefined') return !!__LINKED_EDITOR_BUILD__;
  } catch {
    /* not defined by the bundler */
  }
  if (typeof process !== 'undefined' && process.env?.LINKED_EDITOR_BUILD === '1') return true;
  return false;
}

/** Force the flag (tests, or a runtime toggle). Pass `undefined` to clear. */
export function setEditorBuild(on: boolean | undefined): void {
  override = on;
}
