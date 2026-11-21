import { testCatalogAccessibility } from './design-catalog-a11y.ts';
import { test } from './fixtures.ts';

// 各 assertion の待ちは延ばさず、カタログ全体の axe 検査は60秒以内で確かめる。
test.setTimeout(60_000);

testCatalogAccessibility(1280);
