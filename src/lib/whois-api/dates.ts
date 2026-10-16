const MONTHS = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december',
];

export function calendarDate(
	year: string,
	month: string,
	day: string,
	time = '00:00:00',
): string | null {
	return isoDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${time}Z`);
}

export function monthNumber(month: string): string {
	const name = month.toLowerCase();
	return String(
		MONTHS.findIndex(
			value =>
				value === name || value.slice(0, 3) === name || (value === 'september' && name === 'sept'),
		) + 1,
	);
}

// Date.parse alone accepts years, identifiers and impossible dates (February
// 31 rolls into March). Require a complete, valid calendar date instead.
export function isoDate(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	const named = trimmed.match(
		/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2}))?)?$/i,
	);
	if (named) {
		const zone = /^(?:UTC|GMT)$/i.test(named[5] ?? '') ? 'Z' : (named[5] ?? 'Z');
		return isoDate(
			`${named[3]}-${monthNumber(named[2]).padStart(2, '0')}-${named[1].padStart(2, '0')}T${named[4] ?? '00:00:00'}${zone}`,
		);
	}
	const parts = trimmed.match(
		/^(\d{4})[-/.](\d{2})[-/.](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i,
	);
	if (!parts) return null;
	const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] =
		parts;
	const midnight = new Date(`${year}-${month}-${day}T00:00:00Z`);
	if (
		!Number.isFinite(midnight.getTime()) ||
		midnight.getUTCFullYear() !== Number(year) ||
		midnight.getUTCMonth() + 1 !== Number(month) ||
		midnight.getUTCDate() !== Number(day) ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59
	)
		return null;
	// WHOIS timestamps without a timezone are consistently interpreted as UTC.
	const timestamp = Date.parse(
		`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${zone}`,
	);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
