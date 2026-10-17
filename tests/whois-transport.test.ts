import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net, { type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { describe, it } from 'node:test';

import { RegistrationProvider } from '../src/lib/whois-api/provider.ts';
import { UpstreamScheduler } from '../src/lib/whois-api/scheduler.ts';

describe('WHOIS address family fallback', () => {
	for (const { name, family, addresses } of [
		{
			name: 'reaches IPv6 when the first IPv4 address refuses the connection',
			family: 6,
			addresses: [
				{ address: '127.0.0.1', family: 4 },
				{ address: '::1', family: 6 },
			],
		},
		{
			name: 'reaches IPv4 when the first IPv6 address refuses the connection',
			family: 4,
			addresses: [
				{ address: '::1', family: 6 },
				{ address: '127.0.0.1', family: 4 },
			],
		},
		{
			name: 'continues to query IPv4-only registries',
			family: 4,
			addresses: [{ address: '127.0.0.1', family: 4 }],
		},
	]) {
		it(name, { timeout: 5000 }, async t => {
			const raw = await readFile(new URL('./fixtures/whois/jisc.txt', import.meta.url), 'utf8');
			const queries: string[] = [];
			const fixture = net.createServer(socket => {
				let query = '';
				socket.setEncoding('utf8');
				socket.on('data', chunk => {
					query += chunk;
					if (!query.endsWith('\r\n')) return;
					queries.push(query);
					socket.end(raw);
				});
			});
			fixture.listen({ host: family === 6 ? '::1' : '127.0.0.1', port: 0, ipv6Only: true });
			await once(fixture, 'listening');
			const address = fixture.address();
			assert.ok(address && typeof address !== 'string');
			const nativeConnect = net.connect;
			const failedFamilies: number[] = [];
			const lookup: LookupFunction = (_host, options, callback) => {
				// Honor family/all exactly as DNS would: a forced family must fail this test.
				const matching: LookupAddress[] = addresses.filter(
					item => !options.family || item.family === options.family,
				);
				queueMicrotask(() =>
					options.all
						? callback(null, matching)
						: callback(null, matching[0].address, matching[0].family),
				);
			};
			t.mock.method(net, 'connect', (options: TcpNetConnectOpts, listener?: () => void) => {
				assert.equal(options.host, 'whois.ja.net');
				assert.equal(options.port, 43);
				const socket = nativeConnect({ ...options, port: address.port, lookup }, listener);
				socket.on('connectionAttemptFailed', (_address, _port, family) => {
					failedFamilies.push(family);
				});
				return socket;
			});
			syncBuiltinESMExports();
			try {
				const provider = new RegistrationProvider(new UpstreamScheduler(1, 1));
				const result = await provider.lookup('example.ac.uk', AbortSignal.timeout(3000));
				assert.equal(result.registrationStatus, 'registered');
				assert.equal(result.dates.createdAt, '2003-09-18T00:00:00.000Z');
				assert.deepEqual(queries, ['example.ac.uk\r\n']);
				assert.deepEqual(failedFamilies, addresses.length > 1 ? [addresses[0].family] : []);
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
				await new Promise<void>((resolve, reject) =>
					fixture.close(error => (error ? reject(error) : resolve())),
				);
			}
		});
	}
});
