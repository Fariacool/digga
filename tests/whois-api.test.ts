import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { whoisConfig } from '../src/lib/whois-api/config.ts';
import { batchDomains, singleDomain } from '../src/lib/whois-api/http.ts';
import {
	emptyRecord,
	failure,
	LookupError,
	normalizeLookupDomain,
} from '../src/lib/whois-api/model.ts';
import { isoDate, rdapRecord, whoisRecord } from '../src/lib/whois-api/normalize.ts';
import { schemas, whoisOpenApi } from '../src/lib/whois-api/openapi.ts';
import { retryAfterSeconds } from '../src/lib/whois-api/provider.ts';
import { UpstreamScheduler } from '../src/lib/whois-api/scheduler.ts';
import { WhoisService } from '../src/lib/whois-api/service.ts';

const request = (body: string, headers = { 'Content-Type': 'application/json' }) =>
	new Request('http://localhost/api/whois/batch', { method: 'POST', headers, body });
const isCode = (code: string) => (error: unknown) =>
	error instanceof LookupError && error.code === code;

describe('WHOIS API input and runtime limits', () => {
	it('normalizes IDNs, case and public suffix subdomains', () => {
		assert.equal(normalizeLookupDomain(' www.Example.CO.UK. '), 'example.co.uk');
		assert.equal(normalizeLookupDomain('www.bücher.de'), 'xn--bcher-kva.de');
		assert.equal(normalizeLookupDomain('tenant.blogspot.com'), 'blogspot.com');
		for (const invalid of [
			'https://example.com',
			'example.com/path',
			'example.com:43',
			'me@example.com',
			'127.0.0.1',
			'2001:db8::1',
			'AS13335',
			'com',
			'example.invalid',
			'-bad.com',
			'a..com',
			'_mail.example.com',
			'a'.repeat(64) + '.com',
			'example.com\nINJECT',
		]) {
			assert.throws(() => normalizeLookupDomain(invalid), isCode('INVALID_DOMAIN'), invalid);
		}
	});
	it('rejects ambiguous query parameters and secrets in URLs', () => {
		assert.equal(
			singleDomain(new Request('http://localhost/api/whois?domain=example.com')),
			'example.com',
		);
		for (const query of [
			'',
			'domain=a.com&domain=b.com',
			'q=a.com',
			'domain=a.com&api_key=secret',
		]) {
			assert.throws(
				() => singleDomain(new Request(`http://localhost/api/whois?${query}`)),
				isCode('INVALID_REQUEST'),
			);
		}
	});
	it('validates the whole batch shape but leaves domain validation to each item', async () => {
		assert.deepEqual(
			await batchDomains(request('{"domains":["example.com","bad domain",""]}'), 3),
			['example.com', 'bad domain', ''],
		);
		for (const body of [
			'{',
			'null',
			'[]',
			'{}',
			'{"domains":[]}',
			'{"domains":[1]}',
			'{"domains":["a.com"],"other":true}',
		]) {
			await assert.rejects(batchDomains(request(body), 10), isCode('INVALID_REQUEST'));
		}
		await assert.rejects(
			batchDomains(request('{"domains":["a.com","a.com"]}'), 1),
			isCode('BATCH_TOO_LARGE'),
		);
		await assert.rejects(
			batchDomains(request('{}', { 'Content-Type': 'text/plain' }), 10),
			isCode('UNSUPPORTED_MEDIA_TYPE'),
		);
		await assert.rejects(batchDomains(request(' '.repeat(65537)), 10), isCode('PAYLOAD_TOO_LARGE'));
	});
	it('has independent bounded settings and safe defaults', () => {
		assert.deepEqual(whoisConfig({}), {
			batchLimit: 10,
			maxConcurrent: 20,
			perServerConcurrent: 5,
		});
		assert.deepEqual(
			whoisConfig({
				WHOIS_BATCH_LIMIT: ' 4 ',
				WHOIS_MAX_CONCURRENT: '40',
				WHOIS_PER_SERVER_CONCURRENT: '8',
			}),
			{ batchLimit: 4, maxConcurrent: 40, perServerConcurrent: 8 },
		);
		for (const invalid of ['0', '-1', '1.5', 'Infinity', '100000000', 'abc']) {
			assert.equal(whoisConfig({ WHOIS_MAX_CONCURRENT: invalid }).maxConcurrent, 20);
		}
	});
});

describe('normalized registration records', () => {
	it('reuses RDAP data, validates identity and returns stable nullable fields', () => {
		const data = rdapRecord('example.com', 'https://rdap.example', {
			objectClassName: 'domain',
			ldhName: 'EXAMPLE.COM',
			status: ['active'],
			events: [
				{ eventAction: 'registration', eventDate: '2020-01-02T03:04:05+02:00' },
				{ eventAction: 'expiration', eventDate: 'invalid' },
			],
			nameservers: [{ objectClassName: 'nameserver', ldhName: 'NS1.EXAMPLE.COM.' }],
			secureDNS: { delegationSigned: false },
		});
		assert.equal(data.dates.createdAt, '2020-01-02T01:04:05.000Z');
		assert.equal(data.dates.expiresAt, null);
		assert.equal(data.registrar.name, null);
		assert.equal(data.dnssec, false);
		assert.deepEqual(data.nameservers, ['ns1.example.com']);
		assert.throws(
			() =>
				rdapRecord('example.com', 'https://rdap.example', {
					objectClassName: 'domain',
					ldhName: 'different.com',
				}),
			isCode('LOOKUP_FAILED'),
		);
		assert.throws(
			() => rdapRecord('example.com', 'https://rdap.example', { objectClassName: 'domain' }),
			isCode('LOOKUP_FAILED'),
		);
	});
	it('merges usable WHOIS registry and registrar records, preserving unsigned DNSSEC', () => {
		const record = whoisRecord('example.com', {
			'whois.registry.example': {
				'Domain Name': 'EXAMPLE.COM',
				'Registrar': 'Registry registrar',
				'Created Date': '2000-01-01',
				'Name Server': ['NS1.EXAMPLE.COM 192.0.2.1'],
				'DNSSEC': 'unsigned',
			},
			'whois.registrar.example': {
				'Domain Name': 'example.com',
				'Registrar': 'Registrar',
				'Expiry Date': '2030-01-01T00:00:00Z',
			},
		});
		assert.equal(record.server, 'whois.registrar.example');
		assert.equal(record.registrar.name, 'Registrar');
		assert.equal(record.dates.createdAt, '2000-01-01T00:00:00.000Z');
		assert.equal(record.dnssec, false);
		assert.deepEqual(record.nameservers, ['ns1.example.com']);
		assert.equal(isoDate('2026-10-16 12:00:00'), '2026-10-16T12:00:00.000Z');
	});
	it('never interprets an error, rate limit, disclaimer or empty answer as a registration', () => {
		assert.equal(
			whoisRecord('missing.com', { 'whois.example': { __raw: 'No match for "MISSING.COM".' } })
				.registrationStatus,
			'not_found',
		);
		for (const raw of [
			'',
			'Access denied',
			'Rate limit exceeded',
			'Timeout',
			'Terms: if no match is found, try another service.',
		]) {
			assert.throws(
				() => whoisRecord('example.com', { 'whois.example': { __raw: raw, error: 'failed' } }),
				raw,
			);
		}
		assert.throws(
			() =>
				whoisRecord('example.com', {
					'whois.example': { __raw: 'No match for "EXAMPLE.COM".\nRate limit exceeded' },
				}),
			isCode('UPSTREAM_RATE_LIMITED'),
		);
	});
	it('parses Retry-After seconds and HTTP dates', () => {
		assert.equal(retryAfterSeconds('120'), 120);
		assert.equal(
			retryAfterSeconds('Fri, 16 Oct 2026 00:02:00 GMT', Date.parse('2026-10-16T00:00:00Z')),
			120,
		);
		assert.equal(retryAfterSeconds(null), 60);
		assert.equal(retryAfterSeconds('garbage'), 60);
		assert.equal(retryAfterSeconds('9'.repeat(400)), 60);
	});
});

describe('shared outbound scheduler', () => {
	it('enforces global and per-host caps without head-of-line blocking', async () => {
		const scheduler = new UpstreamScheduler(3, 2);
		const counts = new Map<string, number>();
		let active = 0;
		let maxActive = 0;
		let maxPerHost = 0;
		const started: string[] = [];
		await Promise.all(
			['a', 'a', 'a', 'a', 'b', 'b', 'c', 'c'].map(host =>
				scheduler.run(host, AbortSignal.timeout(1000), async () => {
					started.push(host);
					active++;
					counts.set(host, (counts.get(host) ?? 0) + 1);
					maxActive = Math.max(maxActive, active);
					maxPerHost = Math.max(maxPerHost, counts.get(host)!);
					await delay(5);
					active--;
					counts.set(host, counts.get(host)! - 1);
				}),
			),
		);
		assert.equal(maxActive, 3);
		assert.equal(maxPerHost, 2);
		assert.deepEqual(started.slice(0, 3), ['a', 'a', 'b']);
	});
	it('releases failed permits, cancels queued work and bounds admission', async () => {
		const scheduler = new UpstreamScheduler(1, 1, 1);
		let finish!: () => void;
		const active = scheduler.run(
			'a',
			AbortSignal.timeout(1000),
			() =>
				new Promise<void>(resolve => {
					finish = resolve;
				}),
		);
		await delay(0);
		const abort = new AbortController();
		const queued = scheduler.run('a', abort.signal, async () =>
			assert.fail('aborted task started'),
		);
		await assert.rejects(
			scheduler.run('b', AbortSignal.timeout(1000), async () => {}),
			isCode('BUSY'),
		);
		abort.abort();
		await assert.rejects(queued, isCode('LOOKUP_TIMEOUT'));
		finish();
		await active;
		await assert.rejects(
			scheduler.run('b', AbortSignal.timeout(1000), async () => {
				throw new Error('upstream failed');
			}),
			/upstream failed/,
		);
		assert.equal(
			await scheduler.run('b', AbortSignal.timeout(1000), async () => 'released'),
			'released',
		);
	});
	it('rejects new and queued requests during an upstream cooldown', async () => {
		const scheduler = new UpstreamScheduler(1, 1);
		let finish!: () => void;
		const active = scheduler.run(
			'a',
			AbortSignal.timeout(1000),
			() =>
				new Promise<void>(resolve => {
					finish = resolve;
				}),
		);
		const queued = scheduler.run('a', AbortSignal.timeout(1000), async () =>
			assert.fail('rate limited task started'),
		);
		scheduler.cooldown('a', 60);
		await assert.rejects(queued, isCode('UPSTREAM_RATE_LIMITED'));
		await assert.rejects(
			scheduler.run('a', AbortSignal.timeout(1000), async () => {}),
			isCode('UPSTREAM_RATE_LIMITED'),
		);
		finish();
		await active;
		assert.equal(
			await scheduler.run('b', AbortSignal.timeout(1000), async () => 'other host'),
			'other host',
		);
	});
});

describe('single/batch shared cache and in-flight deduplication', () => {
	it('shares normalized lookups, caches only successful data and expires entries', async () => {
		let calls = 0;
		let now = Date.parse('2026-10-16T00:00:00Z');
		const service = new WhoisService(
			async () => {
				calls++;
				await delay(5);
				return emptyRecord('rdap', 'https://rdap.example');
			},
			() => now,
			1000,
		);
		const [single, batch] = await Promise.all([
			service.lookup('Example.COM'),
			service.batch(['www.example.com', 'example.com', 'bad domain']),
		]);
		assert.equal(calls, 1);
		assert.equal(single.ok, true);
		assert.deepEqual(
			batch.results.map(result => result.input),
			['www.example.com', 'example.com', 'bad domain'],
		);
		assert.deepEqual(batch.summary, { total: 3, succeeded: 2, failed: 1 });
		assert.equal(batch.results[0].ok && batch.results[0].meta.cached, false);
		const cached = await service.lookup('example.com');
		assert.equal(cached.ok && cached.meta.cached, true);
		assert.equal(calls, 1);
		now += 1001;
		await service.lookup('example.com');
		assert.equal(calls, 2);
		let failures = 0;
		const failing = new WhoisService(async () => {
			failures++;
			throw new LookupError('LOOKUP_TIMEOUT', 'Timed out');
		});
		assert.equal((await failing.lookup('example.com')).ok, false);
		assert.equal((await failing.lookup('example.com')).ok, false);
		assert.equal(failures, 2);
	});
	it('keeps partial failures typed and retryable without leaking internal errors', async () => {
		const service = new WhoisService(async domain => {
			if (domain === 'example.com')
				throw new LookupError('UPSTREAM_RATE_LIMITED', 'Retry later', 60);
			throw new Error('private internal hostname or token');
		});
		const batch = await service.batch(['example.com', 'example.org', 'not valid']);
		assert.deepEqual(batch.summary, { total: 3, succeeded: 0, failed: 3 });
		assert.equal(batch.results[0].ok, false);
		assert.equal(!batch.results[0].ok && batch.results[0].error.retryAfterSeconds, 60);
		assert.equal(JSON.stringify(batch).includes('private internal'), false);
	});
});

describe('OpenAPI contract', () => {
	it('validates as OpenAPI 3.1, contains only WHOIS endpoints and reflects runtime configuration', async () => {
		const spec = whoisOpenApi({ API_KEY: 'never-serialize-this-key', WHOIS_BATCH_LIMIT: '3' });
		await SwaggerParser.validate(JSON.parse(JSON.stringify(spec)));
		assert.deepEqual(Object.keys(spec.paths), ['/api/whois', '/api/whois/batch']);
		assert.equal(JSON.stringify(spec).includes('never-serialize-this-key'), false);
		assert.equal(spec.security.length, 2);
		assert.deepEqual(whoisOpenApi({}).security, []);
		assert.equal(
			spec.paths['/api/whois/batch'].post.requestBody.content['application/json'].schema.properties
				.domains.maxItems,
			3,
		);
	});
	it('validates real service responses and rejects an accidental contract change', async () => {
		const ajv = new Ajv2020({ strict: false });
		addFormats(ajv);
		ajv.addSchema({ $id: 'digga', components: { schemas } });
		const validate = ajv.compile({ $ref: 'digga#/components/schemas/WhoisBatch' });
		const service = new WhoisService(async () => emptyRecord('rdap', 'https://rdap.example'));
		const batch = await service.batch(['example.com', 'invalid']);
		assert.equal(validate(batch), true, JSON.stringify(validate.errors));
		assert.equal(validate({ ...batch, results: [{ ok: true }] }), false);
		assert.equal(
			ajv.compile({ $ref: 'digga#/components/schemas/WhoisFailure' })(
				failure(new LookupError('UNAUTHORIZED', 'Unauthorized')),
			),
			true,
		);
	});
});
