import { domainToASCII } from 'node:url';

import { normalizeRdap } from '../rdap/normalize.ts';
import type { RdapDomain } from '../rdap/types.ts';
import { isoDate } from './dates.ts';
import { emptyRecord, LookupError, type WhoisData } from './model.ts';
import { registryWhoisBlock } from './registries.ts';

export { isoDate } from './dates.ts';

function dates(events: WhoisData['events']): WhoisData['dates'] {
	return {
		createdAt: events.find(event => event.action === 'registration')?.date ?? null,
		updatedAt: events.find(event => event.action === 'last changed')?.date ?? null,
		expiresAt: events.find(event => event.action === 'expiration')?.date ?? null,
	};
}

function nameservers(values: string[]): string[] {
	return [
		...new Set(
			values
				.map(value => domainToASCII(value.trim().split(/\s/)[0].replace(/\.$/, '')).toLowerCase())
				.filter(Boolean),
		),
	];
}

function nullableText(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export function rdapRecord(domain: string, server: string, raw: RdapDomain): WhoisData {
	const returnedDomain = raw.ldhName ?? raw.unicodeName;
	if (
		raw.objectClassName !== 'domain' ||
		typeof returnedDomain !== 'string' ||
		domainToASCII(returnedDomain).toLowerCase().replace(/\.$/, '') !== domain ||
		(raw.status !== undefined &&
			(!Array.isArray(raw.status) || !raw.status.every(value => typeof value === 'string'))) ||
		(raw.events !== undefined &&
			(!Array.isArray(raw.events) ||
				!raw.events.every(
					event =>
						event && typeof event.eventAction === 'string' && typeof event.eventDate === 'string',
				)))
	) {
		throw new LookupError('LOOKUP_FAILED', 'The upstream returned an invalid RDAP domain record.');
	}
	const data = normalizeRdap(domain, server, raw);
	const events = data.events.flatMap(event => {
		const date = isoDate(event.date);
		return date ? [{ action: event.action, date }] : [];
	});
	return {
		registrationStatus: 'registered',
		source: 'rdap',
		server,
		registrar: {
			name: nullableText(data.registrar?.name),
			ianaId: nullableText(data.registrar?.ianaId),
			abuseEmail: nullableText(data.registrar?.abuseEmail),
		},
		registrant: {
			name: nullableText(data.registrant?.name),
			organization: nullableText(data.registrant?.organization),
			country: nullableText(data.registrant?.country),
		},
		dates: dates(events),
		events,
		status: [...new Set(data.status)],
		nameservers: nameservers(data.nameservers),
		dnssec: data.dnssec,
	};
}

type WhoisBlock = Record<string, unknown>;
function strings(value: unknown): string[] {
	return (Array.isArray(value) ? value : [value]).filter(
		(value): value is string => typeof value === 'string' && value.length > 0,
	);
}

export function whoisTextError(raw: string): LookupError | null {
	if (
		/rate[ -]limit(?:ing)?(?: is| has been)? (?:exceeded|reached)|quota exceeded|too many (?:requests|queries)|query limit (?:exceeded|reached)|exceeded (?:the )?(?:rate[ -]limit|query quota)/i.test(
			raw,
		)
	) {
		return new LookupError(
			'UPSTREAM_RATE_LIMITED',
			'The upstream WHOIS server rate limited the query. Retry later.',
			60,
		);
	}
	if (
		/access denied|permission denied|not authori[sz]ed|query refused|temporarily blocked/i.test(raw)
	) {
		return new LookupError('LOOKUP_FAILED', 'The upstream WHOIS server refused access.');
	}
	return null;
}

export function isWhoisNotFound(raw: string): boolean {
	return /^\s*(?:%\s*)?(?:no match(?: for| found|ing)?\b|not found\b|no (?:entries|data|objects?|such domain) (?:found|available)?\b|domain(?: name)? (?:not found|not registered|is not registered)\b|status:\s*(?:free|available)\b|domain status:\s*(?:free|available)\b)/im.test(
		raw,
	);
}

export function whoisRecord(domain: string, results: Record<string, WhoisBlock>): WhoisData {
	const blocks = Object.entries(results).map(
		([server, block]) => [server, registryWhoisBlock(domain, server, block)] as const,
	);
	const records = blocks.filter(
		([, block]) =>
			!block.error &&
			!whoisTextError(strings(block.__raw).join('\n')) &&
			strings(block['Domain Name']).some(
				name => domainToASCII(name).toLowerCase().replace(/\.$/, '') === domain,
			),
	);
	if (!records.length) {
		for (const [, block] of blocks) {
			const error = whoisTextError(strings(block.__raw).join('\n'));
			if (error) throw error;
		}
		const missing = blocks.find(([, block]) => isWhoisNotFound(strings(block.__raw).join('\n')));
		if (missing) return emptyRecord('whois', missing[0]);
		throw new LookupError('LOOKUP_FAILED', 'The upstream did not return a usable WHOIS record.');
	}
	// Prefer the registrar's record, filling gaps from the registry's record.
	const ordered = records.toReversed();
	const field = (...keys: string[]): string | null => {
		for (const [, block] of ordered) {
			for (const key of keys) {
				const value = strings(block[key])[0];
				if (value) return value;
			}
		}
		return null;
	};
	const events: WhoisData['events'] = [];
	for (const [action, keys] of [
		['registration', ['Created Date', 'Creation Date', 'Registered On']],
		['last changed', ['Updated Date', 'Last Updated']],
		['expiration', ['Expiry Date', 'Registry Expiry Date', 'Expiration Date', 'Expires Date']],
	] as const) {
		const date = isoDate(field(...keys) ?? undefined);
		if (date) events.push({ action, date });
	}
	const dnssec = field('DNSSEC')?.toLowerCase();
	return {
		registrationStatus: 'registered',
		source: 'whois',
		server: ordered[0][0],
		registrar: {
			name: field('Registrar'),
			ianaId: field('Registrar IANA ID'),
			abuseEmail: field('Registrar Abuse Contact Email'),
		},
		registrant: {
			name: field('Registrant Name'),
			organization: field('Registrant Organization'),
			country: field('Registrant Country'),
		},
		dates: dates(events),
		events,
		status: [...new Set(ordered.flatMap(([, block]) => strings(block['Domain Status'])))],
		nameservers: nameservers(ordered.flatMap(([, block]) => strings(block['Name Server']))),
		dnssec:
			dnssec === 'unsigned' || dnssec === 'unsigned delegation'
				? false
				: dnssec?.startsWith('signed')
					? true
					: null,
	};
}
