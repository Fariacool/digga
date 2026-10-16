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

function rawFields(raw: string): Field[] {
	const fields: Field[] = [];
	let section = '';
	let current: Field | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const heading = line.match(/^\[([^\]]+)\]\s*$/);
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

// Adapt verified registry formats before flattened whoiser fields lose section
// boundaries. Never infer a date from footer text or numeric IDs.
export function registryWhoisBlock(domain: string, server: string, block: WhoisBlock): WhoisBlock {
	const host = server.toLowerCase();
	const jisc = host === 'whois.ja.net' && domain.endsWith('.ac.uk');
	const pt = host === 'whois.dns.pt' && domain.endsWith('.pt');
	const il = host === 'whois.isoc.org.il' && domain.endsWith('.il');
	const lv = host === 'whois.nic.lv' && domain.endsWith('.lv');
	const bg = host === 'whois.register.bg' && domain.endsWith('.bg');
	if (!jisc && !pt && !il && !lv && !bg) return block;
	const raw = typeof block.__raw === 'string' ? block.__raw : '';
	const fields = rawFields(raw);
	const value = (label: string, section?: string) =>
		fields.find(
			field => field.label === label && (section === undefined || field.section === section),
		)?.value ?? '';
	const result = { ...block };
	const identity = value('domain', lv ? 'domain' : undefined) || value('domain name');
	if (isDomain(identity, domain)) result['Domain Name'] = domain;
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
	if (pt) {
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
