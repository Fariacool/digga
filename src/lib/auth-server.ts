import 'server-only';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import {
	isAuthorized,
	SESSION_COOKIE_NAME,
	unauthorizedResponse,
	unlockPath,
} from '@/lib/auth-core';

// React only memoizes this during a render pass, never across requests.
export const isRequestAuthorized = cache(async (): Promise<boolean> => {
	const key = process.env.API_KEY;
	if (!key) return true;
	const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
	return isAuthorized(
		headerStore.get('authorization'),
		cookieStore.get(SESSION_COOKIE_NAME)?.value,
		key,
	);
});

export async function requireApiAccess(returnTo = '/'): Promise<void> {
	if (!(await isRequestAuthorized())) redirect(unlockPath(returnTo));
}

export async function apiAccessError(): Promise<Response | null> {
	return (await isRequestAuthorized()) ? null : unauthorizedResponse();
}
