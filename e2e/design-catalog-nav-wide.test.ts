import { testCatalogNavWrapping } from './design-catalog-nav-wrapping.ts';

for (const width of [1280, 1024, 761]) {
  testCatalogNavWrapping(width);
}
