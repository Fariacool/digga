import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
