import { domainToASCII } from 'node:url';

import { calendarDate, isoDate, monthNumber } from './dates.ts';

type WhoisBlock = Record<string, unknown>;
type Field = { label: string; value: string; section: string };

export function subregistryRoute(domain: string): { host: string | null; suffix: string } | null {
	// These namespaces are outside Nominet's registration database. Its 404s
	// cannot establish whether a name in either namespace is registered.
	if (domain.endsWith('.ac.uk')) return { host: 'whois.ja.net', suffix: 'ac.uk' };
	if (domain.endsWith('.nhs.uk')) return { host: null, suffix: 'nhs.uk' };
	return null;
}

function rawFields(raw: string, ee = false): Field[] {
	const fields: Field[] = [];
	let section = '';
	let current: Field | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const heading =
			line.match(/^\[([^\]]+)\]\s*$/) ??
			(ee
				? line.match(
						/^(Domain|Registrant|Administrative contact|Technical contact|Registrar|Name servers):[ \t]*$/i,
					)
				: null);
		if (heading) {
			section = heading[1].toLowerCase();
			current = undefined;
			continue;
		}
		const field = line.match(/^([^\s:%#>][^:]*):\s*(.*)$/);
		if (field) {
			current = { label: field[1].trim().toLowerCase(), value: field[2].trim(), section };
			fields.push(current);
		} else if (current && /^\s+\S/.test(line)) {
			current.value += `${current.value ? '\n' : ''}${line.trim()}`;
		} else if (line.trim()) {
			current = undefined;
		}
	}
	return fields;
}

function dayFirst(value: string, separator: '/' | '-'): string | null {
	const parts = value.match(
		separator === '/'
			? /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{2}:\d{2}:\d{2}))?$/
			: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
	);
	return parts ? calendarDate(parts[3], parts[2], parts[1], parts[4]) : isoDate(value);
}

function jiscDate(value: string): string | null {
	const parts = value.match(/^(?:[A-Za-z]+ )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+) (\d{4})$/);
	return parts ? calendarDate(parts[3], monthNumber(parts[2]), parts[1]) : isoDate(value);
}

function isDomain(value: string, domain: string): boolean {
	return domainToASCII(value).toLowerCase().replace(/\.$/, '') === domain;
}

function clDate(value: string): string | null {
	// Honor the timestamp's explicit abbreviation, including historical dates;
	// do not infer a seasonal offset from today's America/Santiago rules.
	const parts = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (CLST|CLT)$/);
	return parts
		? isoDate(`${parts[1]}T${parts[2]}${parts[3] === 'CLST' ? '-03:00' : '-04:00'}`)
		: isoDate(value);
}

function clIdentity(raw: string, domain: string): boolean {
	const links = [
		...raw.matchAll(/^%% See (https:\/\/www\.nic\.cl\/registry\/Whois\.do\?\S+)[ \t]*\r?$/gm),
	];
	if (links.length !== 1) return false;
	try {
		const url = new URL(links[0][1]);
		return (
			url.origin === 'https://www.nic.cl' &&
			!url.username &&
			!url.password &&
			!url.hash &&
			url.pathname === '/registry/Whois.do' &&
			url.searchParams.getAll('d').length === 1 &&
			isDomain(url.searchParams.get('d')!, domain)
		);
	} catch {
		return false;
	}
}

export function registryWhoisNotFound(domain: string, server: string, raw: string): boolean {
	if (server.toLowerCase() !== 'whois.nic.cl' || !domain.endsWith('.cl')) return false;
	const missing = [...raw.matchAll(/^(\S+): no entries found\.[ \t]*\r?$/gm)];
	return missing.length === 1 && isDomain(missing[0][1], domain);
}

// Adapt verified registry formats before flattened whoiser fields lose section
// boundaries. Never infer a date from footer text or numeric IDs.
export function registryWhoisBlock(domain: string, server: string, block: WhoisBlock): WhoisBlock {
	const host = server.toLowerCase();
	const jisc = host === 'whois.ja.net' && domain.endsWith('.ac.uk');
	const pt = host === 'whois.dns.pt' && domain.endsWith('.pt');
	const il = host === 'whois.isoc.org.il' && domain.endsWith('.il');
	const lv = host === 'whois.nic.lv' && domain.endsWith('.lv');
	const bg = host === 'whois.register.bg' && domain.endsWith('.bg');
	const ee = host === 'whois.tld.ee' && domain.endsWith('.ee');
	const cl = host === 'whois.nic.cl' && domain.endsWith('.cl');
	if (!jisc && !pt && !il && !lv && !bg && !ee && !cl) return block;
	const raw = typeof block.__raw === 'string' ? block.__raw : '';
	const fields = rawFields(raw, ee);
	const value = (label: string, section?: string) =>
		fields.find(
			field => field.label === label && (section === undefined || field.section === section),
		)?.value ?? '';
	const result = { ...block };
	const identity = value('domain', lv ? 'domain' : undefined) || value('domain name');
	if (isDomain(identity, domain)) result['Domain Name'] = domain;
	if (ee) {
		const domainSections = raw.match(/^Domain:[ \t]*\r?$/gim)?.length ?? 0;
		const identities = fields.filter(field => field.section === 'domain' && field.label === 'name');
		const echoes = fields.filter(field => field.label === 'domain name');
		result['Domain Name'] =
			domainSections === 1 &&
			identities.length === 1 &&
			isDomain(identities[0].value, domain) &&
			echoes.every(field => isDomain(field.value, domain))
				? domain
				: null;
	} else if (cl) {
		// NIC Chile echoes the queried name in a registry URL rather than a
		// Domain Name field. Require both that identity and the record structure.
		const echoes = fields.filter(field => ['domain', 'domain name'].includes(field.label));
		const structured =
			Boolean(value('registrar name')) &&
			['registrant name', 'creation date', 'expiration date'].every(label =>
				fields.some(field => field.label === label),
			);
		result['Domain Name'] =
			structured && clIdentity(raw, domain) && echoes.every(field => isDomain(field.value, domain))
				? domain
				: null;
	}
	if (bg) {
		const repeated = identity.match(/^(\S+) \((\S+)\)$/);
		if (repeated && repeated.slice(1).every(name => isDomain(name, domain)))
			result['Domain Name'] = domain;
		const servers = raw.match(
			/(?:^|\n)NAME SERVER INFORMATION:[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\r?\n|$)/i,
		)?.[1];
		result['Name Server'] = servers?.trim().split(/\s+/) ?? [];
		if (value('dnssec') === 'inactive') result.DNSSEC = 'unsigned';
		return result;
	}
	// Discard potentially polluted aliases before setting verified date fields.
	for (const key of [
		'Created Date',
		'Creation Date',
		'Registered On',
		'Updated Date',
		'Last Updated',
		'Expiry Date',
		'Registry Expiry Date',
		'Expiration Date',
		'Expires Date',
	])
		delete result[key];
	if (ee) {
		const date = (label: string) =>
			isoDate(value(label, 'domain').replace(/\s+([+-]\d{2}:?\d{2})$/, '$1'));
		result['Created Date'] = date('registered');
		result['Updated Date'] = date('changed');
		result['Expiry Date'] = date('expire');
		result.Registrar = value('name', 'registrar');
		result['Registrant Name'] = value('name', 'registrant');
		result['Registrant Country'] = value('country', 'registrant');
		result['Domain Status'] = fields
			.filter(field => field.section === 'domain' && field.label === 'status')
			.map(field => field.value);
		result['Name Server'] = fields
			.filter(field => field.section === 'name servers' && field.label === 'nserver')
			.map(field => field.value);
	} else if (cl) {
		result['Created Date'] = clDate(value('creation date'));
		result['Expiry Date'] = clDate(value('expiration date'));
		result.Registrar = value('registrar name');
		result['Registrant Name'] = value('registrant name');
		result['Registrant Organization'] = value('registrant organisation');
		result['Name Server'] = fields
			.filter(field => field.label === 'name server')
			.map(field => field.value);
	} else if (pt) {
		result['Created Date'] = dayFirst(value('creation date'), '/');
		result['Expiry Date'] = dayFirst(value('expiration date'), '/');
	} else if (jisc) {
		result['Created Date'] = jiscDate(value('entry created'));
		result['Updated Date'] = jiscDate(value('entry updated'));
		result['Expiry Date'] = jiscDate(value('renewal date'));
		result.Registrar = value('registered by');
		result['Registrant Organization'] = value('registered for');
		result['Name Server'] = value('servers')
			.split('\n')
			.map(line => line.split(/\s/)[0]);
	} else if (il) {
		// Stop at actual contact records, not admin-c/tech-c references in the
		// domain record. Unmarked contact changes never become domain updates.
		const contact = fields.findIndex(field =>
			/^(?:(?:admin|tech) e-?mail|person|nic-hdl|registrar name)$/.test(field.label),
		);
		const history = fields.slice(0, contact < 0 ? fields.length : contact);
		const domainValue = (label: string) =>
			history.find(field => field.label === label)?.value ?? '';
		const assigned = history
			.filter(field => field.label === 'changed')
			.map(field => field.value.match(/\b(\d{4})(\d{2})(\d{2}) \(Assigned\)$/i))
			.find(Boolean);
		result['Created Date'] =
			dayFirst(domainValue('assigned'), '-') ??
			(assigned ? calendarDate(assigned[1], assigned[2], assigned[3]) : null);
		result['Expiry Date'] = dayFirst(domainValue('validity'), '-');
		const changed = history
			.filter(field => field.label === 'changed')
			.flatMap(field => {
				const date = field.value.match(/\b(\d{4})(\d{2})(\d{2}) \(Changed\)$/i);
				const iso = date ? calendarDate(date[1], date[2], date[3]) : null;
				return iso ? [iso] : [];
			})
			.sort();
		result['Updated Date'] = changed.at(-1) ?? null;
	} else if (lv) {
		// NIC.LV [Whois] Updated is the database refresh time. RegNr is an
		// organisation identifier. Neither is a domain lifecycle date.
		result.Registrar = value('name', 'registrar');
		result['Registrant Organization'] = value('name', 'holder');
		result['Registrant Country'] = value('country', 'holder');
	}
	return result;
}
