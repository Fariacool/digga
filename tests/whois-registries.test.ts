import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { whoisDomain } from 'whoiser';

import { isoDate, whoisRecord, whoisTextError } from '../src/lib/whois-api/normalize.ts';
import { subregistryRoute } from '../src/lib/whois-api/registries.ts';

async function fixture(
	name: string,
	domain: string,
	host: string,
	transform = (raw: string) => raw,
) {
	const raw = transform(
		await readFile(new URL(`./fixtures/whois/${name}.txt`, import.meta.url), 'utf8'),
	);
	const blocks = await whoisDomain(domain, {
		host,
		raw: true,
		follow: 1,
		whoisQuery: async () => raw,
	});
	return whoisRecord(domain, blocks);
}

describe('registry routes and raw WHOIS formats', () => {
	it('routes ac.uk before Nominet and keeps unsupported NHS names out of its database', () => {
		assert.deepEqual(subregistryRoute('example.ac.uk'), { host: 'whois.ja.net', suffix: 'ac.uk' });
		assert.deepEqual(subregistryRoute('example.nhs.uk'), { host: null, suffix: 'nhs.uk' });
		for (const domain of [
			'example.co.uk',
			'example.uk',
			'exampleac.uk',
			'example.pt',
			'example.co.il',
		])
			assert.equal(subregistryRoute(domain), null);
	});
	it('reads PT dates as day/month/year, including ambiguous dates and leap days', async () => {
		const data = await fixture('pt', 'example.pt', 'whois.dns.pt');
		assert.equal(data.dates.createdAt, '2012-02-20T17:08:39.000Z');
		assert.equal(data.dates.expiresAt, '2027-02-20T23:59:39.000Z');
		assert.deepEqual(data.nameservers, ['ns1.example.pt', 'ns2.example.pt']);
		const ambiguous = await fixture('pt', 'example.pt', 'whois.dns.pt', raw =>
			raw.replace('20/02/2012', '04/05/2012'),
		);
		assert.equal(ambiguous.dates.createdAt, '2012-05-04T17:08:39.000Z');
		const invalid = await fixture('pt', 'example.pt', 'whois.dns.pt', raw =>
			raw.replace('20/02/2012', '31/02/2012'),
		);
		assert.equal(invalid.dates.createdAt, null);
		const leap = await fixture('pt', 'example.pt', 'whois.dns.pt', raw =>
			raw.replace('20/02/2012', '29/02/2024'),
		);
		assert.equal(leap.dates.createdAt, '2024-02-29T17:08:39.000Z');
	});
	it('parses Jisc multiline dates, ordinal days and nameserver addresses', async () => {
		const data = await fixture('jisc', 'example.ac.uk', 'whois.ja.net');
		assert.deepEqual(data.dates, {
			createdAt: '2003-09-18T00:00:00.000Z',
			updatedAt: '2025-08-23T00:00:00.000Z',
			expiresAt: '2027-11-23T00:00:00.000Z',
		});
		assert.equal(data.registrar.name, 'Jisc Services Limited');
		assert.equal(data.registrant.organization, 'Example University');
		assert.deepEqual(data.nameservers, ['ns1.example.ac.uk', 'ns2.example.ac.uk']);
	});
	it('uses IL domain assignment and validity, without contact changes or Assigned as updates', async () => {
		const data = await fixture('il', 'example.co.il', 'whois.isoc.org.il');
		assert.deepEqual(data.dates, {
			createdAt: '2014-10-02T00:00:00.000Z',
			updatedAt: '2019-08-28T00:00:00.000Z',
			expiresAt: '2027-10-02T00:00:00.000Z',
		});
		const assignmentOnly = await fixture('il', 'example.co.il', 'whois.isoc.org.il', raw =>
			raw.replace(/^changed:.*\(Changed\)\n/m, ''),
		);
		assert.equal(assignmentOnly.dates.updatedAt, null);
		const legacy = await fixture('il-legacy', 'example.org.il', 'whois.isoc.org.il');
		assert.deepEqual(legacy.dates, {
			createdAt: '1996-01-11T00:00:00.000Z',
			updatedAt: '2020-10-19T00:00:00.000Z',
			expiresAt: '2029-01-11T00:00:00.000Z',
		});
	});
	it('keeps PE database footers and LV registry identifiers out of lifecycle dates', async () => {
		for (const [name, domain, host] of [
			['pe', 'example.com.pe', 'kero.yachay.pe'],
			['lv', 'example.lv', 'whois.nic.lv'],
		]) {
			const data = await fixture(name, domain, host);
			assert.equal(data.registrationStatus, 'registered');
			assert.deepEqual(data.dates, { createdAt: null, updatedAt: null, expiresAt: null });
			assert.deepEqual(data.events, []);
		}
		const lv = await fixture('lv', 'example.lv', 'whois.nic.lv');
		assert.equal(lv.registrar.name, 'Example Registrar');
		assert.equal(lv.registrant.organization, 'Example Organisation');
		const datedPe = await fixture(
			'pe',
			'example.com.pe',
			'kero.yachay.pe',
			raw => raw + '\nCreation Date: 2000-01-02T00:00:00Z\n',
		);
		assert.equal(datedPe.dates.createdAt, '2000-01-02T00:00:00.000Z');
		assert.equal(datedPe.dates.updatedAt, null);
	});
	it('recognizes BG repeated identity and AU registered records with no creation date', async () => {
		const bg = await fixture('bg', 'example.bg', 'whois.register.bg');
		assert.equal(bg.registrationStatus, 'registered');
		assert.equal(bg.dates.createdAt, null);
		assert.deepEqual(bg.nameservers, ['ns1.example.bg', 'ns2.example.bg']);
		assert.equal(bg.dnssec, false);
		await assert.rejects(
			fixture('bg', 'example.bg', 'whois.register.bg', raw =>
				raw.replace('(example.bg)', '(other.bg)'),
			),
		);
		const au = await fixture('au', 'example.com.au', 'whois.auda.org.au');
		assert.equal(au.registrationStatus, 'registered');
		assert.deepEqual(au.dates, {
			createdAt: null,
			updatedAt: '2026-09-09T05:04:46.000Z',
			expiresAt: null,
		});
	});
	it('reads only EE Domain lifecycle fields, excluding contact, registrar and nameserver changes', async () => {
		const data = await fixture('ee', 'example.ee', 'whois.tld.ee');
		assert.deepEqual(data.dates, {
			createdAt: '2010-07-04T01:05:56.000Z',
			updatedAt: '2026-04-14T10:23:27.000Z',
			expiresAt: '2026-12-11T00:00:00.000Z',
		});
		assert.equal(data.registrar.name, 'Example Registrar');
		assert.equal(data.registrant.name, 'Example Organisation');
		assert.equal(data.registrant.country, 'EE');
		assert.deepEqual(data.status, ['ok (paid and in zone)']);
		assert.deepEqual(data.nameservers, ['ns1.example.ee', 'ns2.example.ee']);
		const partial = await fixture('ee', 'example.ee', 'whois.tld.ee', raw =>
			raw.replace(/^changed:    2026.*\n/m, '').replace(/\n/g, '\r\n'),
		);
		assert.equal(partial.registrationStatus, 'registered');
		assert.equal(partial.dates.updatedAt, null);
		const winter = await fixture('ee', 'example.ee', 'whois.tld.ee', raw =>
			raw.replace('2010-07-04 04:05:56 +03:00', '2024-01-04 04:05:56 +02:00'),
		);
		assert.equal(winter.dates.createdAt, '2024-01-04T02:05:56.000Z');
	});
	it('rejects missing, ambiguous or mismatched EE Domain identity despite flattened aliases', async () => {
		for (const transform of [
			(raw: string) => raw.replace('name:       example.ee', 'name:       other.ee'),
			(raw: string) => raw.replace('Domain:\n', ''),
			(raw: string) => raw + '\nDomain:\nname: example.ee\n',
			(raw: string) => raw.replace('status:', 'name: other.ee\nstatus:'),
			(raw: string) => raw + '\nDomain Name: other.ee\n',
		]) {
			await assert.rejects(
				fixture(
					'ee',
					'example.ee',
					'whois.tld.ee',
					raw => transform(raw) + '\nDomain Name: example.ee\n',
				),
			);
		}
	});
	it('verifies NIC Chile footer identity and converts explicit CLST/CLT offsets', async () => {
		const data = await fixture('cl', 'example.cl', 'whois.nic.cl');
		assert.equal(data.registrationStatus, 'registered');
		assert.deepEqual(data.dates, {
			createdAt: '2008-05-16T00:37:12.000Z',
			updatedAt: null,
			expiresAt: '2027-06-11T21:33:00.000Z',
		});
		assert.equal(data.registrar.name, 'Example Registrar');
		assert.equal(data.registrant.organization, 'Example Organisation');
		assert.deepEqual(data.nameservers, ['ns1.example.cl', 'ns2.example.cl']);
		const standard = await fixture('cl', 'example.cl', 'whois.nic.cl', raw =>
			raw.replaceAll('CLST', 'CLT').replace(/\n/g, '\r\n'),
		);
		assert.equal(standard.dates.createdAt, '2008-05-16T01:37:12.000Z');
		assert.equal(standard.dates.expiresAt, '2027-06-11T22:33:00.000Z');
		const unknown = await fixture('cl', 'example.cl', 'whois.nic.cl', raw =>
			raw.replaceAll('CLST', 'UNKNOWN'),
		);
		assert.equal(unknown.registrationStatus, 'registered');
		assert.deepEqual(unknown.dates, { createdAt: null, updatedAt: null, expiresAt: null });
		const invalid = await fixture('cl', 'example.cl', 'whois.nic.cl', raw =>
			raw.replace('2008-05-15', '2008-02-31'),
		);
		assert.equal(invalid.dates.createdAt, null);
	});
	it('keeps CL host, suffix, structure and identity guards for arbitrary or conflicting replies', async () => {
		for (const transform of [
			(raw: string) => raw.replace('?d=example.cl', '?d=other.cl'),
			(raw: string) => raw.replace('?d=example.cl', '?d=example.cl&d=other.cl'),
			(raw: string) => raw.replace('www.nic.cl/registry', 'www.nic.cl.example/registry'),
			(raw: string) => raw.replace(/^%% See.*\n/m, ''),
			(raw: string) => raw + '\nDomain Name: other.cl\n',
			(raw: string) => raw + '\n%% See https://www.nic.cl/registry/Whois.do?d=other.cl\n',
			(raw: string) => raw.replace(/^(?:Registrant|Registrar|Creation|Expiration).*\n/gm, ''),
			(raw: string) => raw + '\nAccess denied\n',
			(raw: string) => raw + '\nQuery limit exceeded\n',
		])
			await assert.rejects(fixture('cl', 'example.cl', 'whois.nic.cl', transform));
		await assert.rejects(fixture('cl', 'example.cl', 'whois.other.example'));
		await assert.rejects(fixture('cl', 'example.com', 'whois.nic.cl'));
	});
	it('accepts CL no entries only for the authoritative host and exact echoed domain', () => {
		const raw = '%% NIC Chile\r\n\r\nexample.cl: no entries found.\r\n';
		const result = whoisRecord('example.cl', { 'whois.nic.cl': { __raw: raw } });
		assert.equal(result.registrationStatus, 'not_found');
		for (const [domain, host] of [
			['other.cl', 'whois.nic.cl'],
			['example.cl', 'whois.other.example'],
			['example.com', 'whois.nic.cl'],
		])
			assert.throws(() => whoisRecord(domain, { [host]: { __raw: raw } }));
	});
	it('classifies the CH client refusal without inventing a rate limit or cooldown', () => {
		const raw =
			'Requests of this client are not permitted. Please use https://www.nic.ch/whois/ for queries.';
		const error = whoisTextError(raw);
		assert.equal(error?.code, 'LOOKUP_FAILED');
		assert.match(error!.message, /refused access/);
		assert.equal(error?.retryAfterSeconds, undefined);
		assert.throws(
			() => whoisRecord('example.ch', { 'whois.nic.ch': { __raw: raw } }),
			/refused access/,
		);
		assert.equal(whoisTextError('The permitted use of WHOIS data is restricted.'), null);
	});
	it('requires complete valid dates and distinguishes rate limits from refusals', () => {
		for (const invalid of [
			'2026',
			'20261016',
			'19960111',
			'126350731',
			'2026-02-31',
			'2026-01-01T24:00:00',
			'Assigned',
			'registrar 20261016 (Assigned)',
		])
			assert.equal(isoDate(invalid), null, invalid);
		assert.equal(isoDate('2024-02-29'), '2024-02-29T00:00:00.000Z');
		assert.equal(isoDate('01-Jan-2000'), '2000-01-01T00:00:00.000Z');
		assert.equal(isoDate('04-Sep-2001 09:40:20 UTC'), '2001-09-04T09:40:20.000Z');
		assert.equal(isoDate('04-Sep-2001 09:40:20+0200'), '2001-09-04T07:40:20.000Z');
		assert.equal(isoDate('04-Sepfoobar-2001'), null);
		assert.equal(whoisTextError('Access denied')?.code, 'LOOKUP_FAILED');
		assert.equal(
			whoisTextError('Query limit exceeded, try again later.')?.code,
			'UPSTREAM_RATE_LIMITED',
		);
		assert.throws(() =>
			whoisRecord('example.com', {
				'whois.example': {
					'Domain Name': 'example.com',
					'__raw': 'Domain Name: example.com\nAccess denied',
				},
			}),
		);
	});
});
