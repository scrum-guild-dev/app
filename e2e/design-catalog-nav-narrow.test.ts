import { testCatalogNavWrapping } from './design-catalog-nav-wrapping.ts';

for (const width of [760, 390, 320]) {
  testCatalogNavWrapping(width);
}
