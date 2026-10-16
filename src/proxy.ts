import { NextResponse, type NextRequest } from 'next/server';

import {
	isAuthorized,
	SESSION_COOKIE_NAME,
	unauthorizedResponse,
	unlockPath,
	withPrivateAuthHeaders,
} from '@/lib/auth-core';

export function proxy(request: NextRequest) {
	if (!process.env.API_KEY || request.nextUrl.pathname === '/api/auth') {
		return NextResponse.next();
	}

	const authorized = isAuthorized(
		request.headers.get('authorization'),
		request.cookies.get(SESSION_COOKIE_NAME)?.value,
	);
	if (!authorized) {
		// Let each Server Action perform its own check and use Next's action redirect.
		// Actions can also be called from public pages outside this matcher.
		if (
			request.method === 'POST' &&
			request.headers.has('next-action') &&
			request.nextUrl.pathname.startsWith('/lookup/')
		) {
			return withPrivateAuthHeaders(NextResponse.next());
		}

		const isNavigation =
			request.method === 'GET' &&
			!request.nextUrl.pathname.startsWith('/api/') &&
			!request.headers.has('authorization') &&
			// Next strips RSC headers before Proxy; browser fetch metadata remains available.
			(request.headers.get('accept')?.includes('text/html') ||
				request.headers.get('sec-fetch-site') === 'same-origin');
		if (isNavigation) {
			const target = unlockPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
			return withPrivateAuthHeaders(NextResponse.redirect(new URL(target, request.url)));
		}
		return unauthorizedResponse();
	}

	return withPrivateAuthHeaders(NextResponse.next());
}

export const config = {
	matcher: ['/lookup/:path*', '/api/:path*'],
};
