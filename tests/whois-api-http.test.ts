import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { createSession, SESSION_COOKIE_NAME } from '../src/lib/auth-core.ts';
import type { WhoisFailure, WhoisSuccess } from '../src/lib/whois-api/model.ts';

const KEY = 'whois-http-fixture-key';
const { version: swaggerVersion } = createRequire(import.meta.url)('swagger-ui-dist/package.json');
type FixtureCall = { type: 'fixture'; protocol: 'rdap' | 'whois'; host: string; domain: string };
type Server = { url: string; child: ChildProcess; calls: FixtureCall[] };
let preparedAssets: Promise<unknown> | undefined;

async function startServer(key: string): Promise<Server> {
	// Match the Docker runner's standalone layout, including the local Swagger bundle.
	preparedAssets ??= Promise.all([
		cp('public', '.next/standalone/public', { recursive: true }),
		cp('.next/static', '.next/standalone/.next/static', { recursive: true }),
	]);
	await preparedAssets;
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const address = socket.address();
	assert.ok(address && typeof address !== 'string');
	const port = address.port;
	await new Promise<void>(resolve => socket.close(() => resolve()));
	const child = spawn(
		process.execPath,
		['--require', resolve('tests/fixtures/whois-upstreams.cjs'), '.next/standalone/server.js'],
		{
			env: {
				...process.env,
				API_KEY: key,
				HOSTNAME: '127.0.0.1',
				PORT: String(port),
				WHOIS_BATCH_LIMIT: '4',
				WHOIS_MAX_CONCURRENT: '3',
				WHOIS_PER_SERVER_CONCURRENT: '1',
				NEXT_PUBLIC_ANALYTICS_ID: '',
				NEXT_PUBLIC_ANALYTICS_SCRIPT: '',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		},
	);
	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream?.on('data', chunk => {
			output = `${output}${chunk}`.slice(-8000);
		});
	const calls: FixtureCall[] = [];
	child.on('message', message => {
		calls.push(message as FixtureCall);
	});
	const url = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (child.exitCode !== null) throw new Error(`WHOIS API server exited: ${output}`);
		try {
			if ((await fetch(`${url}/api/auth`, { signal: AbortSignal.timeout(1000) })).ok)
				return { url, child, calls };
		} catch {
			/* Wait for startup. */
		}
		await delay(100);
	}
	child.kill('SIGKILL');
	throw new Error(`WHOIS API server did not start: ${output}`);
}

async function stopServer(server: Server) {
	if (!server || server.child.exitCode !== null) return;
	const exited = once(server.child, 'exit');
	server.child.kill('SIGTERM');
	const timer = setTimeout(() => server.child.kill('SIGKILL'), 5000);
	await exited;
	clearTimeout(timer);
}

for (const key of [KEY, '']) {
	describe(`WHOIS production HTTP API: ${key ? 'protected' : 'public'}`, { timeout: 90000 }, () => {
		let server: Server;
		let ajv: InstanceType<typeof Ajv2020>;
		before(async () => {
			server = await startServer(key);
			const response = await fetch(`${server.url}/openapi.json`);
			assert.equal(response.status, 200);
			const spec = await response.json();
			await SwaggerParser.validate(structuredClone(spec));
			assert.equal(
				spec.paths['/api/whois/batch'].post.requestBody.content['application/json'].schema
					.properties.domains.maxItems,
				4,
			);
			assert.equal(spec.security.length, key ? 2 : 0);
			assert.equal(JSON.stringify(spec).includes(KEY), false);
			ajv = new Ajv2020({ strict: false });
			addFormats(ajv);
			ajv.addSchema({ $id: 'api', components: spec.components });
		});
		after(async () => {
			await stopServer(server);
		});
		const call = (path: string, init: RequestInit = {}, authenticated = true) =>
			fetch(`${server.url}${path}`, {
				...init,
				headers: {
					...(authenticated && key ? { Authorization: `Bearer ${key}` } : {}),
					...init.headers,
				},
			});
		const read = async (response: Response, status: number, schema: string) => {
			assert.equal(response.status, status);
			assert.match(response.headers.get('content-type') ?? '', /application\/json/);
			assert.match(response.headers.get('cache-control') ?? '', /no-store/);
			assert.match(response.headers.get('vary') ?? '', /Authorization/);
			const body = await response.json();
			const validate = ajv.compile({ $ref: `api#/components/schemas/${schema}` });
			assert.equal(validate(body), true, JSON.stringify(validate.errors));
			assert.equal(JSON.stringify(body).includes(KEY), false);
			return body;
		};
		const batch = (domains: string[]) =>
			call('/api/whois/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domains }),
			});

		it('authenticates before validation, body parsing and cache access', async () => {
			if (!key) return;
			for (const [path, init] of [
				['/api/whois', {}],
				['/api/whois?domain=example.com', {}],
				['/api/whois/batch', { method: 'POST', body: '{invalid' }],
			] as const) {
				const response = await call(path, init, false);
				assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
				const body: WhoisFailure = await read(response, 401, 'WhoisFailure');
				assert.equal(body.error.code, 'UNAUTHORIZED');
			}
			assert.equal(server.calls.length, 0);
		});

		it('returns normalized single results and shares cached results with batches', async () => {
			const single: WhoisSuccess = await read(
				await call('/api/whois?domain=www.Example.COM.'),
				200,
				'WhoisSuccess',
			);
			assert.equal(single.domain, 'example.com');
			assert.equal(single.input, 'www.Example.COM.');
			assert.equal(single.data.source, 'rdap');
			assert.equal(single.data.registrar.name, 'Fixture Registrar');
			assert.equal(single.data.dnssec, false);
			assert.equal(single.meta.cached, false);
			const response = await read(
				await batch(['example.com', 'missing.com', 'bad domain', 'EXAMPLE.COM']),
				200,
				'WhoisBatch',
			);
			assert.deepEqual(response.summary, { total: 4, succeeded: 3, failed: 1 });
			assert.deepEqual(
				response.results.map((item: WhoisSuccess | WhoisFailure) => item.input),
				['example.com', 'missing.com', 'bad domain', 'EXAMPLE.COM'],
			);
			assert.equal(response.results[0].meta.cached, true);
			assert.equal(response.results[1].data.registrationStatus, 'not_found');
			assert.equal(response.results[2].error.code, 'INVALID_DOMAIN');
			assert.equal(response.results[3].meta.cached, true);
			assert.equal(server.calls.filter(call => call.domain === 'example.com').length, 1);
		});

		it('deduplicates concurrent single and batch lookups, including IDNs and subdomains', async () => {
			const [single, response] = await Promise.all([
				call('/api/whois?domain=dedup.com').then(response => read(response, 200, 'WhoisSuccess')),
				batch(['www.dedup.com', 'DEDUP.COM', 'bücher.de', 'www.example.co.uk']).then(response =>
					read(response, 200, 'WhoisBatch'),
				),
			]);
			assert.equal(single.domain, 'dedup.com');
			assert.equal(response.results[2].domain, 'xn--bcher-kva.de');
			assert.equal(response.results[3].domain, 'example.co.uk');
			assert.equal(server.calls.filter(call => call.domain === 'dedup.com').length, 1);
		});

		it('supports browser cookies while explicit Bearer credentials take precedence', async () => {
			const cookie = `${SESSION_COOKIE_NAME}=${createSession(key || 'public-fixture')}`;
			await read(
				await call('/api/whois?domain=example.com', { headers: { Cookie: cookie } }, false),
				200,
				'WhoisSuccess',
			);
			const response = await call(
				'/api/whois?domain=example.com',
				{ headers: { Cookie: cookie, Authorization: 'Bearer wrong' } },
				false,
			);
			await read(response, key ? 401 : 200, key ? 'WhoisFailure' : 'WhoisSuccess');
		});

		it('follows RDAP redirects and falls back through WHOIS registry and registrar records', async () => {
			const redirected = await read(
				await call('/api/whois?domain=redirect.com'),
				200,
				'WhoisSuccess',
			);
			assert.equal(redirected.data.server, 'https://redirect.fixture.example');
			const response = await read(
				await batch(['fallback.com', 'example.org', 'missing.org']),
				200,
				'WhoisBatch',
			);
			assert.equal(response.results[0].data.source, 'whois');
			assert.equal(response.results[0].data.server, 'whois.registrar.example');
			assert.equal(response.results[0].data.registrar.name, 'Fixture WHOIS Registrar');
			assert.equal(response.results[0].data.dates.expiresAt, '2031-02-03T00:00:00.000Z');
			assert.equal(response.results[1].data.source, 'whois');
			assert.equal(response.results[2].data.registrationStatus, 'not_found');
		});

		it('returns typed request errors and enforces runtime limits', async () => {
			for (const path of [
				'/api/whois',
				'/api/whois?domain=example.com&domain=example.org',
				'/api/whois?domain=example.com&key=secret',
				'/api/whois?domain=https://example.com',
			]) {
				await read(await call(path), 400, 'WhoisFailure');
			}
			await read(await batch(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']), 400, 'WhoisFailure');
			await read(
				await call('/api/whois/batch', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: '{',
				}),
				400,
				'WhoisFailure',
			);
			await read(
				await call('/api/whois/batch', { method: 'POST', body: '{}' }),
				415,
				'WhoisFailure',
			);
			await read(
				await call('/api/whois/batch', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: ' '.repeat(65537),
				}),
				413,
				'WhoisFailure',
			);
		});

		it('keeps timeouts and malformed upstream data as errors, without caching them', async () => {
			const response = await read(
				await batch(['malformed.com', 'timeout.com', 'example.com']),
				200,
				'WhoisBatch',
			);
			assert.deepEqual(response.summary, { total: 3, succeeded: 1, failed: 2 });
			assert.equal(response.results[0].error.code, 'LOOKUP_FAILED');
			assert.equal(response.results[1].error.code, 'LOOKUP_TIMEOUT');
			await read(await call('/api/whois?domain=malformed.com'), 502, 'WhoisFailure');
			assert.equal(
				server.calls.filter(call => call.protocol === 'rdap' && call.domain === 'malformed.com')
					.length,
				2,
			);
		});

		it('honors upstream Retry-After and shares cooldowns across single and batch', async () => {
			const first = await call('/api/whois?domain=limited.net');
			assert.equal(first.headers.get('retry-after'), '120');
			const body = await read(first, 429, 'WhoisFailure');
			assert.equal(body.error.code, 'UPSTREAM_RATE_LIMITED');
			const response = await read(await batch(['another.net', 'example.com']), 200, 'WhoisBatch');
			assert.equal(response.results[0].error.code, 'UPSTREAM_RATE_LIMITED');
			assert.ok(response.results[0].error.retryAfterSeconds >= 119);
			assert.equal(server.calls.filter(call => call.host === 'limited.fixture.example').length, 1);
			assert.equal(
				server.calls.some(call => call.protocol === 'whois' && call.domain.endsWith('.net')),
				false,
			);
		});

		it('serves the public reference without exposing credentials', async () => {
			const response = await call('/docs', {}, false);
			assert.equal(response.status, 200);
			const html = await response.text();
			assert.match(html, /Registration data, in JSON/);
			assert.match(html, /OpenAPI 3.1 JSON/);
			assert.equal(html.includes(KEY), false);
			const bundle = await call(
				`/vendor/swagger-ui/${swaggerVersion}/swagger-ui-bundle.js`,
				{},
				false,
			);
			assert.equal(bundle.status, 200);
			assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
			assert.match(await bundle.text(), /SwaggerUIBundle/);
		});
	});
}
