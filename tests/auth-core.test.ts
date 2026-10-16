import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createSession,
	isAuthorized,
	safeReturnPath,
	SESSION_MAX_AGE,
	unauthorizedResponse,
	unlockPath,
	verifyApiKey,
	verifySession,
	withPrivateAuthHeaders,
} from '../src/lib/auth-core.ts';

const KEY = 'test-only-api-key';
const NOW = Date.UTC(2026, 9, 16);

describe('API key and Bearer authentication', () => {
	it('allows public access when API_KEY is empty', () => {
		assert.equal(isAuthorized(null, undefined, ''), true);
		assert.equal(isAuthorized('Bearer anything', 'anything', ''), true);
	});
	it('compares keys exactly regardless of their length', () => {
		assert.equal(verifyApiKey(KEY, KEY), true);
		for (const invalid of ['', 'x', KEY.toUpperCase(), `${KEY} `, `${KEY}x`, 'x'.repeat(4096)]) {
			assert.equal(verifyApiKey(invalid, KEY), false);
		}
		assert.equal(verifyApiKey('', ''), false);
	});
	it('accepts Bearer schemes case-insensitively', () => {
		for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
			assert.equal(isAuthorized(`${scheme} ${KEY}`, undefined, KEY), true);
		}
	});
	it('rejects absent, malformed, and incorrect credentials', () => {
		for (const header of [
			null,
			'',
			'Basic anything',
			'Bearer',
			'Bearer wrong',
			`Bearer ${KEY} extra`,
			`Bearer  ${KEY}`,
		]) {
			assert.equal(isAuthorized(header, undefined, KEY), false);
		}
	});
	it('checks the current environment on each request', () => {
		const previous = process.env.API_KEY;
		try {
			delete process.env.API_KEY;
			assert.equal(isAuthorized(null, undefined), true);
			process.env.API_KEY = KEY;
			assert.equal(isAuthorized(null, undefined), false);
			assert.equal(isAuthorized(`Bearer ${KEY}`, undefined), true);
			process.env.API_KEY = 'rotated-key';
			assert.equal(isAuthorized(`Bearer ${KEY}`, undefined), false);
		} finally {
			if (previous === undefined) delete process.env.API_KEY;
			else process.env.API_KEY = previous;
		}
	});
});

describe('signed browser sessions', () => {
	it('issues distinct signed tokens without the raw API key', () => {
		const session = createSession(KEY, NOW);
		assert.equal(verifySession(session, KEY, NOW), true);
		assert.equal(session.includes(KEY), false);
		assert.notEqual(session, createSession(KEY, NOW));
		assert.throws(() => createSession(''));
	});
	it('expires exactly at the seven-day deadline', () => {
		const session = createSession(KEY, NOW);
		assert.equal(verifySession(session, KEY, NOW + SESSION_MAX_AGE * 1000 - 1), true);
		assert.equal(verifySession(session, KEY, NOW + SESSION_MAX_AGE * 1000), false);
	});
	it('rejects altered payloads, signatures, malformed tokens and raw keys', () => {
		const session = createSession(KEY, NOW);
		const parts = session.split('.');
		for (const index of [0, 1, 2, 3]) {
			const changed = [...parts];
			changed[index] =
				index === 1
					? String(Number(changed[index]) + 86400)
					: `${changed[index][0] === 'x' ? 'y' : 'x'}${changed[index].slice(1)}`;
			assert.equal(verifySession(changed.join('.'), KEY, NOW), false);
		}
		for (const invalid of [undefined, '', KEY, 'v1.0.a.b', `${session}.extra`, session.slice(1)]) {
			assert.equal(verifySession(invalid, KEY, NOW), false);
		}
	});
	it('invalidates sessions after a key rotation', () => {
		assert.equal(verifySession(createSession(KEY, NOW), 'rotated-key', NOW), false);
	});
	it('uses the cookie only when explicit Authorization is absent', () => {
		const session = createSession(KEY);
		assert.equal(isAuthorized(null, session, KEY), true);
		assert.equal(isAuthorized('Bearer wrong', session, KEY), false);
		assert.equal(isAuthorized('', session, KEY), false);
		assert.equal(isAuthorized(`Bearer ${KEY}`, 'invalid-cookie', KEY), true);
	});
});

describe('private responses and safe navigation', () => {
	it('disables shared caching and preserves existing Vary headers', () => {
		const response = withPrivateAuthHeaders(
			new Response('ok', { headers: { Vary: 'RSC, Accept' } }),
		);
		assert.match(response.headers.get('Cache-Control')!, /private, no-store/);
		assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
		assert.equal(response.headers.get('Vary'), 'RSC, Accept, Cookie, Authorization');
	});
	it('returns a Bearer challenge on unauthorized responses', async () => {
		const response = unauthorizedResponse();
		assert.equal(response.status, 401);
		assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer realm="digga"');
		assert.deepEqual(await response.json(), { error: 'Unauthorized' });
	});
	it('retains local lookup paths and query strings', () => {
		const path = '/lookup/example.com/dns?resolver=google#records';
		assert.equal(safeReturnPath(path), path);
		assert.equal(new URL(unlockPath(path), 'https://digga.invalid').searchParams.get('next'), path);
	});
	it('rejects external URLs, encoded redirects, controls, and redirect loops', () => {
		for (const path of [
			undefined,
			[],
			'https://evil.test',
			'//evil.test',
			'/\\evil.test',
			'/%2f%2fevil.test',
			'/%5cevil.test',
			'/%0aevil',
			'/unlock',
			'/unlock?next=/unlock',
			'/api/auth',
			'/x/../unlock',
			'/%75nlock',
			'/%',
		]) {
			assert.equal(safeReturnPath(path), '/');
		}
	});
});
