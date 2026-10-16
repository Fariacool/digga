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
