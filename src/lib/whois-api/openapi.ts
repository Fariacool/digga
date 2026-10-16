import { whoisConfig } from './config.ts';
import { ERROR_STATUS } from './model.ts';

const nullableString = { type: ['string', 'null'] };
const nullableDate = { type: ['string', 'null'], format: 'date-time' };
const stringArray = { type: 'array', items: { type: 'string' } };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = <T extends Record<string, unknown>>(properties: T) => ({
	type: 'object',
	additionalProperties: false,
	required: Object.keys(properties),
	properties,
});

export const schemas = {
	WhoisData: object({
		registrationStatus: {
			type: 'string',
			enum: ['registered', 'not_found'],
			description:
				'not_found means the authoritative registration service returned no record. It does not guarantee availability. A registered record with null dates is a valid partial result, not not_found.',
		},
		source: { type: 'string', enum: ['rdap', 'whois'] },
		server: { type: 'string', description: 'The responding RDAP origin or WHOIS hostname.' },
		registrar: object({ name: nullableString, ianaId: nullableString, abuseEmail: nullableString }),
		registrant: object({
			name: nullableString,
			organization: nullableString,
			country: nullableString,
		}),
		dates: object({ createdAt: nullableDate, updatedAt: nullableDate, expiresAt: nullableDate }),
		events: {
			type: 'array',
			items: object({ action: { type: 'string' }, date: { type: 'string', format: 'date-time' } }),
		},
		status: {
			...stringArray,
			description: 'Registration status values as reported by the source.',
		},
		nameservers: {
			...stringArray,
			description: 'Lowercase hostnames from the registration record; no DNS lookup is performed.',
		},
		dnssec: {
			type: ['boolean', 'null'],
			description:
				'Whether the registration record reports a signed delegation; null when unknown.',
		},
	}),
	WhoisSuccess: object({
		ok: { const: true },
		input: { type: 'string', description: 'The original input.' },
		domain: {
			type: 'string',
			description:
				'The lowercase ASCII registrable domain. Subdomains are reduced using the public suffix list.',
		},
		data: ref('WhoisData'),
		meta: object({
			cached: {
				type: 'boolean',
				description:
					'True only for an unexpired completed cache entry. Joining an in-flight lookup is false.',
			},
			fetchedAt: { type: 'string', format: 'date-time' },
			expiresAt: { type: 'string', format: 'date-time' },
			durationMs: { type: 'integer', minimum: 0 },
		}),
	}),
	WhoisFailure: object({
		ok: { const: false },
		input: nullableString,
		domain: nullableString,
		error: {
			type: 'object',
			additionalProperties: false,
			required: ['code', 'message', 'retryable'],
			properties: {
				code: { type: 'string', enum: Object.keys(ERROR_STATUS) },
				message: {
					type: 'string',
					description:
						'Diagnostic text including the public upstream and stage when known. Use code for client logic.',
				},
				retryable: { type: 'boolean' },
				retryAfterSeconds: { type: 'integer', minimum: 1 },
			},
		},
	}),
	WhoisResult: { oneOf: [ref('WhoisSuccess'), ref('WhoisFailure')] },
	WhoisBatch: object({
		ok: {
			const: true,
			description: 'The batch was accepted. Inspect each item for lookup success.',
		},
		results: {
			type: 'array',
			items: ref('WhoisResult'),
			minItems: 1,
			description: 'One outcome per input, in the original order, including duplicates.',
		},
		summary: object({
			total: { type: 'integer', minimum: 1 },
			succeeded: { type: 'integer', minimum: 0 },
			failed: { type: 'integer', minimum: 0 },
		}),
	}),
};

const response = (description: string, schema: string) => ({
	description,
	content: { 'application/json': { schema: ref(schema) } },
});
const errors = Object.fromEntries(
	[400, 401, 413, 415, 422, 429, 502, 503, 504].map(status => [
		String(status),
		{
			...response(
				Object.entries(ERROR_STATUS)
					.filter(([, value]) => value === status)
					.map(([code]) => code)
					.join(', '),
				'WhoisFailure',
			),
			...([429, 503].includes(status)
				? {
						headers: {
							'Retry-After': {
								description: 'Seconds to wait before retrying.',
								schema: { type: 'integer', minimum: 1 },
							},
						},
					}
				: {}),
			...(status === 401
				? { headers: { 'WWW-Authenticate': { schema: { type: 'string' } } } }
				: {}),
		},
	]),
);

export function whoisOpenApi(env: Record<string, string | undefined> = process.env) {
	const config = whoisConfig(env);
	return {
		openapi: '3.1.2',
		info: {
			title: 'digga WHOIS API',
			version: '1.0.0',
			description: `Domain registration data, independent of Overview, DNS, Subdomains, Email and TLS. RDAP is preferred with WHOIS fallback. Missing fields are null; dates are UTC ISO 8601. Successful results (including not_found) are cached for one hour per process. Errors are not cached. Requests share in-flight lookups and an outbound queue: ${config.maxConcurrent} connections per process, ${config.perServerConcurrent} per external hostname. Each upstream request has a 5 second deadline; a lookup including queueing has a 30 second deadline. Authentication is checked before validation and cache access. ${env.API_KEY ? 'Authentication is required on this instance.' : 'API_KEY is unset: this instance allows public access.'}`,
			license: {
				name: 'AGPL-3.0-only with additional attribution terms',
				url: 'https://github.com/maaaathis/digga/blob/main/LICENSE',
			},
		},
		servers: [{ url: '/' }],
		tags: [{ name: 'WHOIS', description: 'Domain registration information only.' }],
		security: env.API_KEY ? [{ bearerAuth: [] }, { cookieAuth: [] }] : [],
		paths: {
			'/api/whois': {
				get: {
					tags: ['WHOIS'],
					operationId: 'getWhois',
					summary: 'Look up one domain',
					description:
						'Accepts a domain name (including IDNs and subdomains), without a URL, port, IP or ASN. Supply exactly one domain parameter; API keys belong in the Authorization header.',
					parameters: [
						{
							name: 'domain',
							in: 'query',
							required: true,
							schema: { type: 'string', minLength: 1 },
							example: 'example.com',
						},
					],
					responses: {
						'200': response(
							'Registration data or an authoritative not_found result.',
							'WhoisSuccess',
						),
						...Object.fromEntries(
							Object.entries(errors).filter(([status]) => !['413', '415'].includes(status)),
						),
					},
				},
			},
			'/api/whois/batch': {
				post: {
					tags: ['WHOIS'],
					operationId: 'batchWhois',
					summary: 'Look up a small batch of domains',
					description: `Accepts at most ${config.batchLimit} entries (duplicates count). Returns HTTP 200 for an accepted batch, even if every lookup fails. Check results[].ok and results[].error; each error uses the same codes as a single lookup. An invalid domain fails only that item; an invalid request shape rejects the entire batch. Maximum body size: 64 KiB.`,
					requestBody: {
						required: true,
						content: {
							'application/json': {
								schema: object({
									domains: {
										type: 'array',
										minItems: 1,
										maxItems: config.batchLimit,
										items: { type: 'string' },
									},
								}),
								example: { domains: ['example.com', 'example.org'] },
							},
						},
					},
					responses: {
						'200': response(
							'Ordered per-domain outcomes; partial failures are preserved.',
							'WhoisBatch',
						),
						...Object.fromEntries(
							Object.entries(errors).filter(([status]) =>
								['400', '401', '413', '415', '502'].includes(status),
							),
						),
					},
				},
			},
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					description:
						'The server API_KEY. An explicit Authorization header takes precedence over the cookie.',
				},
				cookieAuth: {
					type: 'apiKey',
					in: 'cookie',
					name: 'digga-session',
					description:
						'The HttpOnly session issued by the web API key dialog. Browsers send it automatically; scripts should use Bearer.',
				},
			},
			schemas,
		},
	};
}
