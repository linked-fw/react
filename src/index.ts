export * from './package.js';
export * from './utils/LinkedComponent.js';
export * from './utils/LinkedComponentClass.js';
export * from './utils/Hooks.js';
export * from './utils/ClassNames.js';
export * from './utils/useQueryContext.js';
export {LinkedInfinityLoader} from './loaders/LinkedInfinityLoader.js';
// Generic element-interceptor seam. The editor runtime lives in a separate
// (proprietary) package that registers an interceptor here — no editor code
// ships in @_linked/react.
export {
  registerElementInterceptor,
  useElementInterceptor,
  type ElementInterceptor,
} from './utils/elementInterceptor.js';
