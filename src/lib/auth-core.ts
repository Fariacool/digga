import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'digga-session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export function verifyApiKey(actual: string, expected: string): boolean {
	if (!actual || !expected) return false;
	return timingSafeEqual(
		createHash('sha256').update(actual).digest(),
		createHash('sha256').update(expected).digest(),
	);
}

function signSession(payload: string, key: string): string {
	return createHmac('sha256', key).update(`digga:session:${payload}`).digest('base64url');
}

export function createSession(key: string, now = Date.now()): string {
	if (!key) throw new Error('An API key is required to create a session');
	const expires = Math.floor(now / 1000) + SESSION_MAX_AGE;
	const payload = `v1.${expires}.${randomBytes(24).toString('base64url')}`;
	return `${payload}.${signSession(payload, key)}`;
}

export function verifySession(session: string | undefined, key: string, now = Date.now()): boolean {
	if (!session || !key) return false;
	const match = session.match(/^v1\.(\d{10,12})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/);
	if (!match || Number(match[1]) <= Math.floor(now / 1000)) return false;
	const payload = session.slice(0, session.lastIndexOf('.'));
	return verifyApiKey(match[3], signSession(payload, key));
}

export function isAuthorized(
	authorization: string | null,
	session: string | undefined,
	key = process.env.API_KEY,
): boolean {
	if (!key) return true;
	// Explicit credentials take precedence over a browser session.
	if (authorization !== null) {
		const token = authorization.match(/^Bearer ([^\s]+)$/i)?.[1];
		return Boolean(token && verifyApiKey(token, key));
	}
	return verifySession(session, key);
}

export function withPrivateAuthHeaders<T extends Response>(response: T): T {
	response.headers.set('Cache-Control', 'private, no-store, max-age=0');
	response.headers.set('CDN-Cache-Control', 'no-store');
	response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
	const vary = new Set(
		(response.headers.get('Vary') ?? '')
			.split(',')
			.map(value => value.trim())
			.filter(Boolean),
	);
	vary.add('Cookie');
	vary.add('Authorization');
	response.headers.set('Vary', [...vary].join(', '));
	return response;
}

export function unauthorizedResponse(): Response {
	return withPrivateAuthHeaders(
		Response.json(
			{ error: 'Unauthorized' },
			{ status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="digga"' } },
		),
	);
}

export function safeReturnPath(value: unknown): string {
	if (typeof value !== 'string' || !value.startsWith('/')) return '/';
	try {
		const decoded = decodeURIComponent(value);
		const unsafeCharacter = [...decoded].some(
			character =>
				character === '\\' || character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
		);
		if (decoded.startsWith('//') || unsafeCharacter) return '/';
		const url = new URL(value, 'https://digga.invalid');
		if (url.origin !== 'https://digga.invalid') return '/';
		if (/^\/(unlock|api)(\/|$)/.test(decodeURIComponent(url.pathname))) return '/';
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/';
	}
}

export function unlockPath(returnTo: string): string {
	return `/unlock?${new URLSearchParams({ next: safeReturnPath(returnTo) })}`;
}
