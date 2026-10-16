import { NextResponse, type NextRequest } from 'next/server';

import {
	createSession,
	isAuthorized,
	SESSION_COOKIE_NAME,
	SESSION_MAX_AGE,
	unauthorizedResponse,
	verifyApiKey,
	withPrivateAuthHeaders,
} from '@/lib/auth-core';

export const dynamic = 'force-dynamic';

function sameOrigin(request: NextRequest): boolean {
	if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
	const origin = request.headers.get('origin');
	const host =
		request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
		request.headers.get('host') ||
		request.nextUrl.host;
	const protocol =
		request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
		request.nextUrl.protocol.slice(0, -1);
	return !origin || origin === `${protocol}://${host}`;
}

function cookieOptions(request: NextRequest) {
	return {
		httpOnly: true,
		secure:
			request.nextUrl.protocol === 'https:' ||
			request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https',
		sameSite: 'lax' as const,
		path: '/',
	};
}

function forbidden() {
	return withPrivateAuthHeaders(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
}

export function GET(request: NextRequest) {
	const enabled = Boolean(process.env.API_KEY);
	const authenticated =
		enabled &&
		isAuthorized(
			request.headers.get('authorization'),
			request.cookies.get(SESSION_COOKIE_NAME)?.value,
		);
	return withPrivateAuthHeaders(NextResponse.json({ enabled, authenticated }));
}

export async function POST(request: NextRequest) {
	if (!sameOrigin(request)) return forbidden();
	const key = process.env.API_KEY;
	if (!key)
		return withPrivateAuthHeaders(NextResponse.json({ enabled: false, authenticated: false }));

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return withPrivateAuthHeaders(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
	}
	const apiKey = body && typeof body === 'object' && 'apiKey' in body ? body.apiKey : null;
	if (typeof apiKey !== 'string' || !verifyApiKey(apiKey, key)) return unauthorizedResponse();

	const response = withPrivateAuthHeaders(
		NextResponse.json({ enabled: true, authenticated: true }),
	);
	response.cookies.set(SESSION_COOKIE_NAME, createSession(key), {
		...cookieOptions(request),
		maxAge: SESSION_MAX_AGE,
	});
	return response;
}

export function DELETE(request: NextRequest) {
	if (!sameOrigin(request)) return forbidden();
	const response = withPrivateAuthHeaders(NextResponse.json({ authenticated: false }));
	response.cookies.set(SESSION_COOKIE_NAME, '', { ...cookieOptions(request), maxAge: 0 });
	return response;
}
