import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveSiteOrigin } from '../src/lib/site-origin.ts';

describe('site origin resolution', () => {
	it('uses a normalized explicit override before request headers', () => {
		assert.equal(
			resolveSiteOrigin(
				new Headers({ 'host': 'internal:3000', 'x-forwarded-host': 'other.example' }),
				'  https://override.example:8443/  ',
			),
			'https://override.example:8443',
		);
		assert.equal(
			resolveSiteOrigin(new Headers(), 'https://override.example/'),
			'https://override.example',
		);
	});

	it('detects the Cloudflare origin when SITE_URL is absent, empty or whitespace', () => {
		const headers = new Headers({ 'host': 'tunnel.example', 'x-forwarded-proto': 'https' });
		for (const value of [undefined, '', '   ', '\t']) {
			assert.equal(resolveSiteOrigin(headers, value), 'https://tunnel.example');
		}
	});

	it('uses the first forwarded host and protocol and preserves external ports', () => {
		assert.equal(
			resolveSiteOrigin(
				new Headers({
					'host': 'app:3000',
					'x-forwarded-host': ' public.example:8443, internal.example ',
					'x-forwarded-proto': ' https, http ',
				}),
			),
			'https://public.example:8443',
		);
	});

	it('uses Host and HTTP for direct requests without proxy headers', () => {
		assert.equal(
			resolveSiteOrigin(new Headers({ host: '127.0.0.1:4321' })),
			'http://127.0.0.1:4321',
		);
		assert.equal(
			resolveSiteOrigin(new Headers({ host: 'localhost:4000' })),
			'http://localhost:4000',
		);
	});

	it('supports IPv6 host headers', () => {
		assert.equal(
			resolveSiteOrigin(new Headers({ 'host': '[::1]:4321', 'x-forwarded-proto': 'https' })),
			'https://[::1]:4321',
		);
	});

	it('falls back to Host when the forwarded host is blank', () => {
		assert.equal(
			resolveSiteOrigin(new Headers({ 'host': 'request.example', 'x-forwarded-host': '  ' })),
			'http://request.example',
		);
	});

	it('does not allow an unsafe forwarded protocol', () => {
		assert.equal(
			resolveSiteOrigin(
				new Headers({ 'host': 'request.example', 'x-forwarded-proto': 'javascript' }),
			),
			'http://request.example',
		);
	});

	it('rejects missing or malformed host headers instead of inventing a domain', () => {
		assert.throws(() => resolveSiteOrigin(new Headers()));
		for (const host of [
			'user@host.example',
			'host.example/path',
			'host.example?x=1',
			'host.example#x',
			'host.example\\path',
			'host.example:99999',
			'host example',
		]) {
			assert.throws(() => resolveSiteOrigin(new Headers({ host })), host);
		}
	});

	it('rejects configured URLs that are not HTTP(S) origins', () => {
		for (const value of [
			'not-a-url',
			'javascript:alert(1)',
			'ftp://host.example',
			'https://user:password@host.example',
			'https://host.example/path',
			'https://host.example?x=1',
			'https://host.example#x',
		]) {
			assert.throws(() => resolveSiteOrigin(new Headers(), value), value);
		}
	});
});
