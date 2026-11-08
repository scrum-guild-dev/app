import { redirect } from '@sveltejs/kit';
import { callOperation } from '../../../lib/api.ts';
import { consentUrl, isTermsRequired, isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
import { setupReturnTo } from '../../../lib/onboarding.ts';
import { slugProblem } from '../../../shared/organization-slug.ts';
import { me } from '../../../shared/operations/session/index.ts';
import { onboardingStatus } from '../../../shared/operations/session/onboarding.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
  const teamSlug = url.searchParams.get('team') ?? undefined;
  if (teamSlug !== undefined && slugProblem(teamSlug) !== undefined) return { failed: true as const };
  const [status, person] = await Promise.all([
    callOperation(onboardingStatus, {}, { fetcher: fetch }),
    callOperation(me, {}, { fetcher: fetch }),
  ]);
  if (isUnauthenticated(status) || isUnauthenticated(person)) redirect(307, loginUrl(url));
  if (isTermsRequired(status)) redirect(307, consentUrl(url));
  if (!status.ok || !person.ok) return { failed: true as const };
  return {
    failed: false as const,
    status: status.data,
    person: person.data,
    teamSlug: status.data.personal?.available && status.data.profile !== null ? teamSlug : undefined,
    returnTo: setupReturnTo(url.searchParams.get('return_to')),
  };
};
