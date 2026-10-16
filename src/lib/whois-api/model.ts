import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse } from 'tldts';

export const ERROR_STATUS = {
	INVALID_REQUEST: 400,
	INVALID_DOMAIN: 400,
	BATCH_TOO_LARGE: 400,
	UNAUTHORIZED: 401,
	PAYLOAD_TOO_LARGE: 413,
	UNSUPPORTED_MEDIA_TYPE: 415,
	UNSUPPORTED_TLD: 422,
	UPSTREAM_RATE_LIMITED: 429,
	LOOKUP_FAILED: 502,
	BUSY: 503,
	LOOKUP_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class LookupError extends Error {
	code: ErrorCode;
	retryAfterSeconds?: number;

	constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
		super(message);
		this.name = 'LookupError';
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export type WhoisData = {
	registrationStatus: 'registered' | 'not_found';
	source: 'rdap' | 'whois';
	server: string;
	registrar: { name: string | null; ianaId: string | null; abuseEmail: string | null };
	registrant: { name: string | null; organization: string | null; country: string | null };
	dates: { createdAt: string | null; updatedAt: string | null; expiresAt: string | null };
	events: { action: string; date: string }[];
	status: string[];
	nameservers: string[];
	dnssec: boolean | null;
};

export type WhoisSuccess = {
	ok: true;
	input: string;
	domain: string;
	data: WhoisData;
	meta: { cached: boolean; fetchedAt: string; expiresAt: string; durationMs: number };
};

export type WhoisFailure = {
	ok: false;
	input: string | null;
	domain: string | null;
	error: {
		code: ErrorCode;
		message: string;
		retryable: boolean;
		retryAfterSeconds?: number;
	};
};

export type WhoisResult = WhoisSuccess | WhoisFailure;

export function failure(
	error: unknown,
	input: string | null = null,
	domain: string | null = null,
): WhoisFailure {
	const known =
		error instanceof LookupError
			? error
			: new LookupError('LOOKUP_FAILED', 'The registration service could not complete the lookup.');
	return {
		ok: false,
		input,
		domain,
		error: {
			code: known.code,
			message: known.message,
			retryable: ['UPSTREAM_RATE_LIMITED', 'LOOKUP_FAILED', 'LOOKUP_TIMEOUT', 'BUSY'].includes(
				known.code,
			),
			...(known.retryAfterSeconds !== undefined
				? { retryAfterSeconds: known.retryAfterSeconds }
				: {}),
		},
	};
}

export function normalizeLookupDomain(input: string): string {
	const trimmed = input.trim().replace(/\.$/, '');
	const domain = domainToASCII(trimmed).toLowerCase();
	if (
		!domain ||
		domain.length > 253 ||
		isIP(domain) ||
		/[\s/:@?#\\]/.test(trimmed) ||
		!domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		throw new LookupError(
			'INVALID_DOMAIN',
			'Provide a domain name without a URL, IP address or port.',
		);
	}
	const parsed = parse(domain, { allowPrivateDomains: false });
	if (!parsed.isIcann || !parsed.domain) {
		throw new LookupError('INVALID_DOMAIN', 'Provide a domain under a recognized public suffix.');
	}
	return parsed.domain;
}

export function emptyRecord(source: WhoisData['source'], server: string): WhoisData {
	return {
		registrationStatus: 'not_found',
		source,
		server,
		registrar: { name: null, ianaId: null, abuseEmail: null },
		registrant: { name: null, organization: null, country: null },
		dates: { createdAt: null, updatedAt: null, expiresAt: null },
		events: [],
		status: [],
		nameservers: [],
		dnssec: null,
	};
}
