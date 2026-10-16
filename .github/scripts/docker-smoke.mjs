import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const expectedArch = { amd64: 'x64', arm64: 'arm64' }[process.env.EXPECTED_ARCH];
assert.ok(expectedArch, 'EXPECTED_ARCH must be amd64 or arm64');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, expectedArch, 'The image must match the native runner');
assert.notEqual(process.getuid(), 0, 'The container must run as a non-root user');
assert.ok(process.env.API_KEY, 'Set a runtime API_KEY for the smoke test');
execFileSync('/app/bin/subfinder', ['-version'], { stdio: 'inherit', timeout: 10_000 });

async function request(path, authenticated = false) {
	return fetch(`http://127.0.0.1:3000${path}`, {
		headers: authenticated ? { Authorization: `Bearer ${process.env.API_KEY}` } : {},
		signal: AbortSignal.timeout(5000),
	});
}

let ready = false;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
	try {
		const response = await request('/api/auth');
		if (response.ok) {
			assert.deepEqual(await response.json(), { enabled: true, authenticated: false });
			ready = true;
			break;
		}
		await response.body?.cancel();
	} catch {
		// The standalone server may still be starting.
	}
	await delay(250);
}
assert.ok(ready, 'The container must become ready within 30 seconds');

const authenticated = await request('/api/auth', true);
assert.equal(authenticated.status, 200);
assert.deepEqual(await authenticated.json(), { enabled: true, authenticated: true });

const page = await request('/unlock');
assert.equal(page.status, 200, 'The standalone server must serve HTML');
const html = await page.text();
const script = html.match(/src="(\/_next\/static\/[^\"]+)"/)?.[1];
assert.ok(script, 'The page must reference a Next.js static script');
for (const path of [script, '/digga-background.svg']) {
	const response = await request(path);
	assert.equal(response.status, 200, `Static asset: ${path}`);
	await response.arrayBuffer();
}

console.log(
	`Container smoke test passed on ${process.arch}: subfinder, runtime API key, HTML and static assets.`,
);
