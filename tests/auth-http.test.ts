import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE } from '../src/lib/auth-core.ts';

const KEY = 'http-test-only-key';
const REPORT = '/lookup/example.com/subdomains';
const ENTRY = `/api/from/base64/${Buffer.from(encodeURIComponent('https://example.com/path')).toString('base64url')}`;

type TestServer = { url: string; child: ChildProcess };

async function startServer(key: string): Promise<TestServer> {
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const address = socket.address();
	assert.ok(address && typeof address !== 'string');
	const port = address.port;
	await new Promise<void>(resolve => socket.close(() => resolve()));
	const child = spawn(
		process.execPath,
		['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
		{
			env: { ...process.env, API_KEY: key },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	let output = '';
	for (const stream of [child.stdout, child.stderr]) {
		stream?.on('data', chunk => {
			output = `${output}${chunk}`.slice(-8000);
		});
	}
	const url = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
		try {
			const response = await fetch(`${url}/api/auth`, { signal: AbortSignal.timeout(1000) });
			if (response.ok) return { url, child };
		} catch {
			/* Wait for the production server to accept requests. */
		}
		await delay(100);
	}
	child.kill('SIGKILL');
	throw new Error(`Test server did not start: ${output}`);
}

async function stopServer(server: TestServer | undefined) {
	if (!server || server.child.exitCode !== null) return;
	const exited = once(server.child, 'exit');
	server.child.kill('SIGTERM');
	const killTimer = setTimeout(() => server.child.kill('SIGKILL'), 5000);
	await exited;
	clearTimeout(killTimer);
}

function assertPrivate(response: Response) {
	assert.match(response.headers.get('cache-control') ?? '', /private/);
	assert.match(response.headers.get('cache-control') ?? '', /no-store/);
	assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
}

describe('protected production server', { timeout: 90000 }, () => {
	let server: TestServer;
	before(async () => {
		server = await startServer(KEY);
	});
	after(async () => {
		await stopServer(server);
	});
	const request = (path: string, init?: RequestInit) =>
		fetch(`${server.url}${path}`, { redirect: 'manual', ...init });
	const login = (key: string, headers: HeadersInit = {}) =>
		request('/api/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify({ apiKey: key }),
		});

	it('keeps status public without exposing the key or issuing a session', async () => {
		const response = await request('/api/auth');
		assert.deepEqual(await response.json(), { enabled: true, authenticated: false });
		assert.equal(response.headers.get('set-cookie'), null);
		assertPrivate(response);
	});

	it('rejects anonymous lookup pages, metadata images, and both existing APIs', async () => {
		for (const path of [
			'/lookup/example.com',
			'/lookup/example.com/dns',
			'/lookup/example.com/whois',
			REPORT,
			'/lookup/example.com/email',
			'/lookup/example.com/tls',
			'/lookup/example.com/opengraph-image',
			'/api/stargazers',
			ENTRY,
		]) {
			const response = await request(path);
			assert.equal(response.status, 401, path);
			assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="digga"');
			assertPrivate(response);
		}
	});

	it('redirects browser and RSC navigation to the requested unlock page', async () => {
		const requests: HeadersInit[] = [
			{ accept: 'text/html' },
			{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
		];
		for (const headers of requests) {
			const response = await request(`${REPORT}?from=test`, { headers });
			assert.equal(response.status, 307);
			const target = new URL(response.headers.get('location')!, server.url);
			assert.equal(target.pathname, '/unlock');
			assert.equal(target.searchParams.get('next'), `${REPORT}?from=test`);
			assertPrivate(response);
		}
	});

	it('rejects invalid keys, malformed JSON, and credentials in URLs', async () => {
		const invalid = await login('wrong');
		assert.equal(invalid.status, 401);
		assert.equal(invalid.headers.get('set-cookie'), null);
		const malformed = await request('/api/auth', { method: 'POST', body: '{' });
		assert.equal(malformed.status, 400);
		const urlKey = await request(`${ENTRY}?api_key=${KEY}`);
		assert.equal(urlKey.status, 401);
	});

	it('rejects cross-origin unlock and logout requests', async () => {
		for (const method of ['POST', 'DELETE']) {
			const response = await request('/api/auth', {
				method,
				headers: { 'origin': 'https://untrusted.invalid', 'Content-Type': 'application/json' },
				body: method === 'POST' ? JSON.stringify({ apiKey: KEY }) : undefined,
			});
			assert.equal(response.status, 403);
			assert.equal(response.headers.get('set-cookie'), null);
			assertPrivate(response);
		}
	});

	it('issues a signed HttpOnly cookie for a valid same-origin key', async () => {
		const response = await login(KEY, { origin: server.url });
		assert.equal(response.status, 200);
		const cookie = response.headers.get('set-cookie')!;
		assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=v1.`));
		assert.equal(cookie.includes(KEY), false);
		assert.match(cookie, /HttpOnly/i);
		assert.match(cookie, /SameSite=lax/i);
		assert.match(cookie, /Path=\//i);
		assert.match(cookie, new RegExp(`Max-Age=${SESSION_MAX_AGE}`));
		const status = await request('/api/auth', { headers: { cookie: cookie.split(';')[0] } });
		assert.deepEqual(await status.json(), { enabled: true, authenticated: true });
		assertPrivate(response);
	});

	it('sets Secure on HTTPS deployments', async () => {
		const response = await login(KEY, { 'x-forwarded-proto': 'https' });
		assert.equal(response.status, 200);
		assert.match(response.headers.get('set-cookie')!, /; Secure/i);
	});

	it('accepts the browser origin forwarded by a reverse proxy', async () => {
		const response = await login(KEY, {
			'origin': 'https://digga.example',
			'x-forwarded-host': 'digga.example',
			'x-forwarded-proto': 'https',
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get('set-cookie')!, /; Secure/i);
	});

	it('accepts Bearer and Cookie credentials on reports and integration redirects', async () => {
		const session = createSession(KEY);
		const requests: HeadersInit[] = [
			{ authorization: `Bearer ${KEY}` },
			{ cookie: `${SESSION_COOKIE_NAME}=${session}` },
		];
		for (const headers of requests) {
			const report = await request(REPORT, { headers });
			assert.equal(report.status, 200);
			assertPrivate(report);
			const entry = await request(ENTRY, { headers });
			assert.equal(entry.status, 307);
			assert.equal(
				new URL(entry.headers.get('location')!, server.url).href,
				`${server.url}/lookup/example.com`,
			);
			assertPrivate(entry);
		}
	});

	it('rejects explicit invalid Bearer credentials even with a valid cookie', async () => {
		const response = await request(REPORT, {
			headers: {
				authorization: 'Bearer wrong',
				cookie: `${SESSION_COOKIE_NAME}=${createSession(KEY)}`,
			},
		});
		assert.equal(response.status, 401);
	});

	it('rejects expired, forged, and rotated sessions', async () => {
		for (const session of [
			KEY,
			'forged',
			createSession('previous-key'),
			createSession(KEY, Date.now() - SESSION_MAX_AGE * 1000),
		]) {
			const response = await request(REPORT, {
				headers: { cookie: `${SESSION_COOKIE_NAME}=${session}` },
			});
			assert.equal(response.status, 401);
		}
	});

	it('checks authorization inside every callable Server Action', async () => {
		const manifest = JSON.parse(
			await readFile('.next/server/server-reference-manifest.json', 'utf8'),
		) as {
			node: Record<string, { exportedName: string }>;
		};
		const actions = Object.entries(manifest.node);
		assert.ok(actions.length >= 3);
		for (const [id, action] of actions) {
			const response = await request(REPORT, {
				method: 'POST',
				headers: { 'Next-Action': id, 'Content-Type': 'text/plain', 'Origin': server.url },
				body: JSON.stringify([
					action.exportedName === 'fetchIpDetails' ? '127.0.0.1' : 'example.com',
				]),
			});
			assert.match(
				response.headers.get('x-action-redirect') ?? '',
				/^\/unlock\?next=/,
				action.exportedName,
			);
			assertPrivate(response);
		}
	});

	it('protects generated images without retaining their public cache headers', async () => {
		const response = await request('/lookup/example.com/opengraph-image', {
			headers: { authorization: `Bearer ${KEY}` },
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type') ?? '', /image\/png/);
		assertPrivate(response);
	});

	it('prevents an external return URL after unlocking', async () => {
		const response = await request('/unlock?next=//untrusted.invalid', {
			headers: { cookie: `${SESSION_COOKIE_NAME}=${createSession(KEY)}` },
		});
		assert.equal(response.status, 307);
		assert.equal(new URL(response.headers.get('location')!, server.url).pathname, '/');
	});

	it('expires the browser cookie when locking the instance', async () => {
		const response = await request('/api/auth', {
			method: 'DELETE',
			headers: { origin: server.url },
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get('set-cookie')!, /Max-Age=0/i);
		assertPrivate(response);
	});
});

describe('public production server', { timeout: 90000 }, () => {
	let server: TestServer;
	before(async () => {
		server = await startServer('');
	});
	after(async () => {
		await stopServer(server);
	});

	it('disables authentication with an empty API_KEY', async () => {
		const response = await fetch(`${server.url}/api/auth`);
		assert.deepEqual(await response.json(), { enabled: false, authenticated: false });
	});

	it('allows anonymous access to reports and integration redirects', async () => {
		const report = await fetch(`${server.url}${REPORT}`);
		assert.equal(report.status, 200);
		const entry = await fetch(`${server.url}${ENTRY}`, { redirect: 'manual' });
		assert.equal(entry.status, 307);
		assert.equal(
			new URL(entry.headers.get('location')!, server.url).href,
			`${server.url}/lookup/example.com`,
		);
	});

	it('does not set a cookie when protection is disabled', async () => {
		const response = await fetch(`${server.url}/api/auth`, { method: 'POST' });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('set-cookie'), null);
	});
});
