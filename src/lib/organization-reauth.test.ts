import { afterEach, expect, test, vi } from 'vitest';
import { callOperation } from './api.ts';
import { organizationReauthUrl } from './login-redirect.ts';
import { organizationInfo } from '../shared/operations/organization/index.ts';

afterEach(() => vi.unstubAllGlobals());

test('組織の再認証は、安全な戻り先と案内の理由を付ける', () => {
  expect(organizationReauthUrl({ pathname: '/aoba/me', search: '?tab=x' })).toBe(
    '/login?return_to=%2Faoba%2Fme%3Ftab%3Dx&error=organization_reauth_required',
  );
  expect(organizationReauthUrl({ pathname: '//example.com', search: '' })).toBe(
    '/login?return_to=%2F&error=organization_reauth_required',
  );
});

test.each([
  ['aoba', 401, 'organization_reauth_required', true],
  ['elsewhere', 401, 'organization_reauth_required', false],
  ['aoba', 404, 'not_found', false],
  ['aoba', 401, 'unauthenticated', false],
  ['aoba', 403, 'organization_reauth_required', false],
])('表示中の組織だけをログインへ移す: %s %s %s', async (slug, status, code, moves) => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/aoba/me', search: '', replace } });
  const result = await callOperation(
    organizationInfo,
    {},
    {
      slug,
      fetcher: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: code } }), { status })),
    },
  );
  expect(result).toMatchObject({ ok: false, status, error: { code } });
  expect(replace).toHaveBeenCalledTimes(moves ? 1 : 0);
  if (moves) expect(replace).toHaveBeenCalledWith('/login?return_to=%2Faoba%2Fme&error=organization_reauth_required');
});
