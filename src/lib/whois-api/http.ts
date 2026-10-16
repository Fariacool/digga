import { withPrivateAuthHeaders } from '../auth-core.ts';
import { MAX_BODY_BYTES } from './config.ts';
import {
	ERROR_STATUS,
	failure,
	LookupError,
	type WhoisFailure,
	type WhoisResult,
} from './model.ts';

export function apiJson(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	return withPrivateAuthHeaders(Response.json(body, { status, headers: extraHeaders }));
}

export function errorResponse(body: WhoisFailure): Response {
	const headers = new Headers();
	if (body.error.code === 'UNAUTHORIZED') headers.set('WWW-Authenticate', 'Bearer realm="digga"');
	if (body.error.retryAfterSeconds !== undefined)
		headers.set('Retry-After', String(body.error.retryAfterSeconds));
	return apiJson(body, ERROR_STATUS[body.error.code], headers);
}

export function whoisUnauthorized(): Response {
	return errorResponse(
		failure(
			new LookupError('UNAUTHORIZED', 'A valid Bearer API key or browser session is required.'),
		),
	);
}

export function resultResponse(result: WhoisResult): Response {
	return result.ok ? apiJson(result) : errorResponse(result);
}

export function singleDomain(request: Request): string {
	const params = new URL(request.url).searchParams;
	if (params.getAll('domain').length !== 1 || [...params.keys()].some(key => key !== 'domain')) {
		throw new LookupError('INVALID_REQUEST', 'Provide exactly one domain query parameter.');
	}
	return params.get('domain')!;
}

export async function batchDomains(request: Request, limit: number): Promise<string[]> {
	if (
		request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
	) {
		throw new LookupError('UNSUPPORTED_MEDIA_TYPE', 'Send an application/json request body.');
	}
	if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
		throw new LookupError('PAYLOAD_TOO_LARGE', 'The request body exceeds 64 KiB.');
	}
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_BODY_BYTES)
					throw new LookupError('PAYLOAD_TOO_LARGE', 'The request body exceeds 64 KiB.');
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new LookupError('INVALID_REQUEST', 'The request body must be valid JSON.');
	}
	if (
		!body ||
		typeof body !== 'object' ||
		Array.isArray(body) ||
		Object.keys(body).some(key => key !== 'domains')
	) {
		throw new LookupError('INVALID_REQUEST', 'Provide an object containing only a domains array.');
	}
	const domains = (body as { domains?: unknown }).domains;
	if (
		!Array.isArray(domains) ||
		!domains.length ||
		!domains.every(domain => typeof domain === 'string')
	) {
		throw new LookupError('INVALID_REQUEST', 'domains must be a nonempty array of domain strings.');
	}
	if (domains.length > limit)
		throw new LookupError('BATCH_TOO_LARGE', `A batch may contain at most ${limit} domains.`);
	return domains;
}
