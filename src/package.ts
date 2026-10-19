import {CoreSet} from '@_linked/core/collections/CoreSet';
import {linkedPackage as coreLinkedPackage} from '@_linked/core/utils/Package';
import {Shape} from '@_linked/core/shapes/Shape';
import {sharedState} from '@_linked/core/utils/sharedState';
import {
  type Component,
  createLinkedComponentFn,
  createLinkedSetComponentFn,
} from './utils/LinkedComponent.js';

// The components `linkedComponent` registered for each shape. Kept on `globalThis` so a second
// copy of this module (Vite's SSR runner next to Node, or two bundles) adds to the same registry.
const registry = sharedState('@_linked/react', 'componentRegistry', () => ({
  shapeToComponents: new Map<typeof Shape, CoreSet<Component>>(),
}));

const {
  linkedUtil,
  linkedOntology,
  linkedShape,
  registerPackageExport,
  registerPackageModule,
  packageExports,
  getPackageShape,
} = coreLinkedPackage('@_linked/react');

function registerComponent(exportedComponent: Component, shape?: typeof Shape) {
  if (!shape) {
    if (!Object.prototype.hasOwnProperty.call(exportedComponent, 'shape')) {
      console.warn(
        `Component ${
          (exportedComponent as any).displayName || (exportedComponent as any).name
        } is not linked to a shape.`,
      );
      return;
    }
    shape = exportedComponent.shape;
  }

  let components = registry.shapeToComponents.get(shape);
  if (!components) {
    components = new CoreSet<Component>();
    registry.shapeToComponents.set(shape, components);
  }
  components.add(exportedComponent);
}

const linkedComponent = createLinkedComponentFn(
  registerPackageExport,
  registerComponent,
);

const linkedSetComponent = createLinkedSetComponentFn(
  registerPackageExport,
  registerComponent,
);
export const linkedPackage = (packageName: string) => {
  return {
    linkedComponent,
    linkedSetComponent,
    ...coreLinkedPackage(packageName),
  };
};

export {
  linkedComponent,
  linkedSetComponent,
  linkedShape,
  linkedUtil,
  linkedOntology,
  registerPackageExport,
  registerPackageModule,
  packageExports,
  getPackageShape,
};
