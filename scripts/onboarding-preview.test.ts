import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { dictionary } from '../src/shared/vocabulary.ts';

// 静的見本の SQ.t は引数を補間しない。本番の t で代用せず、同じ契約で見本を実行する。
test('個人用URLと招待時のチーム追加の見本を確認し、入力をHTMLとして出さない', () => {
  const html = readFileSync(new URL('../design/onboarding.html', import.meta.url), 'utf8');
  const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source);
  let rendered = '';
  const esc = (value: string) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );
  const context = vm.createContext({
    SQ: {
      t: (key: keyof typeof dictionary) => dictionary[key] ?? key,
      esc,
      icon: () => '',
      brandMark: '',
      googleMark: '',
      applyTheme() {},
    },
    document: {
      getElementById: () => ({
        set innerHTML(value: string) {
          rendered = value;
        },
        focus() {},
      }),
      addEventListener() {},
    },
    window: { scrollTo() {} },
  });
  vm.runInContext(source, context);
  for (const withTeam of [false, true]) {
    const count = withTeam ? 5 : 3;
    vm.runInContext(`withTeam = ${withTeam};`, context);
    for (let step = 0; step < count; step++) {
      vm.runInContext(`step = ${step}; render();`, context);
      assert.ok(rendered.includes(`${count} ステップ中 ${step + 1}`));
      assert.ok(!/\{(?:total|current|organization|provider)\}/.test(rendered));
      assert.equal((rendered.match(/aria-current="step"/g) ?? []).length, 1);
      assert.equal((rendered.match(/<li /g) ?? []).length, count);
      assert.ok(rendered.includes(dictionary.onboardingDisclosure));
      assert.equal(vm.runInContext('new Set(titles).size === titles.length', context), true);
      assert.ok(!rendered.includes('type="radio"'));
      if (step === 1) {
        assert.ok(rendered.includes('id="personal-slug"'));
        assert.ok(!rendered.includes('id="organization"'));
      }
      if (step === 2) {
        assert.ok(rendered.includes(dictionary.onboardingNoTeam));
        assert.ok(rendered.includes(dictionary.onboardingAddTeam));
        assert.ok(!rendered.includes('id="invitations"'));
      }
      if (step === 4) {
        assert.ok(rendered.includes(dictionary.onboardingFinish));
        assert.ok(rendered.includes(dictionary.onboardingSkipFinish));
      }
    }
  }
  vm.runInContext(
    'withTeam = true; step = 3; values.organization = \'<img src=x onerror="alert(1)">\'; render();',
    context,
  );
  assert.ok(!rendered.includes('<img src=x'));
  assert.ok(rendered.includes('&lt;img'));
});
