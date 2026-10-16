import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type TestServer = { url: string; child: ChildProcess };

async function startServer(env: Record<string, string | undefined>): Promise<TestServer> {
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const address = socket.address();
	assert.ok(address && typeof address !== 'string');
	const port = address.port;
	await new Promise<void>(resolve => socket.close(() => resolve()));
	const child = spawn(process.execPath, ['.next/standalone/server.js'], {
		env: {
			...process.env,
			API_KEY: '',
			GOOGLE_SERVICE_KEY_B64: '',
			BIGQUERY_DATASET: '',
			HOSTNAME: '127.0.0.1',
			PORT: String(port),
			...env,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	for (const stream of [child.stdout, child.stderr]) {
		stream?.on('data', chunk => {
			output = `${output}${chunk}`.slice(-8000);
		});
	}
	const url = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (child.exitCode !== null) throw new Error(`Standalone server exited: ${output}`);
		try {
			const response = await fetch(`${url}/api/auth`, { signal: AbortSignal.timeout(1000) });
			if (response.ok) return { url, child };
		} catch {
			/* Wait for the standalone server to accept requests. */
		}
		await delay(100);
	}
	child.kill('SIGKILL');
	throw new Error(`Standalone server did not start: ${output}`);
}

async function stopServer(server: TestServer | undefined) {
	if (!server || server.child.exitCode !== null) return;
	const exited = once(server.child, 'exit');
	server.child.kill('SIGTERM');
	const killTimer = setTimeout(() => server.child.kill('SIGKILL'), 5000);
	await exited;
	clearTimeout(killTimer);
}

// All cases reuse the exact same production build, including its client chunks.
for (const config of [
	{ name: 'unfiltered', analytics: true, domains: undefined, siteKey: 'runtime-site-key-one' },
	{
		name: 'filtered',
		analytics: true,
		domains: 'configured-analytics-domain.example',
		siteKey: 'runtime-site-key-two',
	},
	{ name: 'disabled', analytics: false, domains: '', siteKey: '' },
]) {
	describe(`runtime deployment configuration: ${config.name}`, { timeout: 90000 }, () => {
		let server: TestServer;
		const siteUrl = `https://${config.name}.runtime.example`;
		const script = `https://analytics-${config.name}.example/script.js`;
		const websiteId = `runtime-website-${config.name}`;
		const secret = `runtime-secret-${config.name}`;

		before(async () => {
			server = await startServer({
				SITE_URL: siteUrl,
				NEXT_PUBLIC_ANALYTICS_SCRIPT: config.analytics ? script : '',
				NEXT_PUBLIC_ANALYTICS_ID: config.analytics ? websiteId : '',
				NEXT_PUBLIC_ANALYTICS_DOMAINS: config.domains,
				NEXT_PUBLIC_TURNSTILE_SITE_KEY: config.siteKey,
				TURNSTILE_SECRET: secret,
			});
		});
		after(async () => {
			await stopServer(server);
		});

		const text = async (path: string) => {
			const response = await fetch(`${server.url}${path}`);
			assert.equal(response.status, 200, path);
			const body = await response.text();
			assert.equal(body.includes(secret), false, `${path}: server secret leaked`);
			return body;
		};

		it('uses the runtime origin in page metadata and structured data', async () => {
			for (const path of [
				'/',
				'/dns',
				'/whois',
				'/rdap',
				'/email',
				'/tls',
				'/subdomains',
				'/extension/privacy',
			]) {
				const body = await text(path);
				const url = path === '/' ? siteUrl : `${siteUrl}${path}`;
				assert.ok(body.includes(`rel="canonical" href="${url}"`), path);
				assert.ok(body.includes(`property="og:url" content="${url}"`), path);
				if (path === '/') {
					assert.ok(body.includes(`"url":"${siteUrl}/"`));
					assert.ok(body.includes(`"target":"${siteUrl}/lookup/{search_term_string}"`));
				}
			}
		});

		it('uses the runtime origin in robots, sitemaps and llms.txt', async () => {
			for (const path of [
				'/robots.txt',
				'/sitemap.xml',
				'/sitemap-pages.xml',
				'/sitemap-common.xml',
				'/llms.txt',
			]) {
				const body = await text(path);
				assert.ok(body.includes(siteUrl), path);
				assert.equal(body.includes('http://localhost:3000'), false, path);
			}
		});

		it('uses runtime analytics settings without a default domain filter', async () => {
			const body = await text('/');
			assert.equal(body.includes(script), config.analytics);
			assert.equal(body.includes(websiteId), config.analytics);
			assert.equal(body.includes('data-website-id'), config.analytics);
			if (config.domains) assert.ok(body.includes(config.domains));
			else {
				assert.equal(body.includes('"data-domains":"digga.dev"'), false);
				assert.equal(body.includes('\\"data-domains\\":\\"digga.dev\\"'), false);
			}
		});

		it('passes the runtime Turnstile public key to the client without its secret', async () => {
			const body = await text('/lookup/example.com/subdomains');
			if (config.siteKey) assert.ok(body.includes(config.siteKey));
			assert.equal(body.includes('A quick human check'), Boolean(config.siteKey));
		});
	});
}

for (const config of [
	{ name: 'unset', value: undefined, override: undefined },
	{ name: 'empty', value: '', override: undefined },
	{ name: 'whitespace', value: '   ', override: undefined },
	{
		name: 'explicit override',
		value: '  https://override.example:8443/  ',
		override: 'https://override.example:8443',
	},
]) {
	describe(`request origin with SITE_URL ${config.name}`, { timeout: 90000 }, () => {
		let server: TestServer;
		before(async () => {
			server = await startServer({
				SITE_URL: config.value,
				NEXT_PUBLIC_ANALYTICS_SCRIPT: '',
				NEXT_PUBLIC_ANALYTICS_ID: '',
				NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
				TURNSTILE_SECRET: '',
			});
		});
		after(async () => {
			await stopServer(server);
		});

		const read = async (path: string, headers: Record<string, string>) => {
			// Node's fetch replaces Host; use an HTTP client that preserves proxy headers.
			const body = await new Promise<string>((resolve, reject) => {
				const request = httpRequest(`${server.url}${path}`, { headers }, response => {
					if (response.statusCode !== 200) {
						response.resume();
						reject(new Error(`${path}: HTTP ${response.statusCode}`));
						return;
					}
					let text = '';
					response.setEncoding('utf8');
					response.on('data', chunk => {
						text += chunk;
					});
					response.on('end', () => resolve(text));
					response.on('error', reject);
				});
				request.setTimeout(10_000, () => request.destroy(new Error(`${path}: timed out`)));
				request.on('error', reject);
				request.end();
			});
			assert.equal(body.includes('[object Promise]'), false, path);
			return body;
		};
		const assertPageOrigin = (body: string, path: string, origin: string) => {
			const url = path === '/' ? origin : `${origin}${path}`;
			assert.ok(body.includes(`rel="canonical" href="${url}"`), `${path}: canonical`);
			assert.ok(body.includes(`property="og:url" content="${url}"`), `${path}: og:url`);
			if (path === '/') {
				assert.ok(body.includes(`"url":"${origin}/"`));
				assert.ok(body.includes(`"target":"${origin}/lookup/{search_term_string}"`));
			} else if (path === '/dns') {
				assert.ok(body.includes(`"url":"${origin}/dns"`));
				assert.ok(body.includes(`"url":"${origin}/"`));
			} else if (path === '/lookup/example.com/subdomains') {
				assert.ok(body.includes(`"url":"${origin}/lookup/example.com"`));
				assert.ok(
					body.includes(
						`property="og:image" content="${origin}/lookup/example.com/opengraph-image`,
					),
				);
			}
		};

		it('uses the Cloudflare Host and HTTPS protocol for page URLs and JSON-LD', async () => {
			const headers = { 'host': 'cloudflare-public.example', 'x-forwarded-proto': 'https' };
			const origin = config.override ?? 'https://cloudflare-public.example';
			for (const path of [
				'/',
				'/dns',
				'/email',
				'/rdap',
				'/tls',
				'/whois',
				'/subdomains',
				'/extension/privacy',
				'/lookup/example.com/subdomains',
			]) {
				assertPageOrigin(await read(path, headers), path, origin);
			}
		});

		it('uses the detected origin in robots, all sitemaps and llms.txt', async () => {
			const headers = { 'host': 'documents-public.example', 'x-forwarded-proto': 'https' };
			const origin = config.override ?? 'https://documents-public.example';
			for (const path of [
				'/robots.txt',
				'/sitemap.xml',
				'/sitemap-pages.xml',
				'/sitemap-common.xml',
				'/llms.txt',
			]) {
				const body = await read(path, headers);
				assert.ok(body.includes(`${origin}/`), path);
				assert.equal(body.includes('http://localhost:3000'), false, path);
			}
		});

		it('supports forwarded host/protocol lists and external ports', async () => {
			const headers = {
				'host': 'app.internal:3000',
				'x-forwarded-host': 'forwarded-public.example:8443, intermediate.internal',
				'x-forwarded-proto': 'https, http',
			};
			const origin = config.override ?? 'https://forwarded-public.example:8443';
			assertPageOrigin(await read('/dns', headers), '/dns', origin);
			assert.ok((await read('/sitemap.xml', headers)).includes(`${origin}/sitemap-pages.xml`));
		});

		it('supports direct HTTP access without a fixed hostname or port', async () => {
			const headers = { host: 'localhost:6060' };
			const origin = config.override ?? 'http://localhost:6060';
			assertPageOrigin(await read('/', headers), '/', origin);
			assert.ok((await read('/robots.txt', headers)).includes(`Sitemap: ${origin}/sitemap.xml`));
		});

		it("does not reuse another concurrent request's host or protocol", async () => {
			await Promise.all(
				['one', 'two', 'three'].flatMap(name =>
					['/', '/dns', '/sitemap.xml'].map(async path => {
						const protocol = name === 'two' ? 'http' : 'https';
						const origin = config.override ?? `${protocol}://${name}.public.example`;
						const body = await read(path, {
							'host': `${name}.public.example`,
							'x-forwarded-proto': protocol,
						});
						if (path === '/sitemap.xml') assert.ok(body.includes(`${origin}/sitemap-pages.xml`));
						else assertPageOrigin(body, path, origin);
					}),
				),
			);
		});
	});
}
