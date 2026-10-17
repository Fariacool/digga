import { connect } from 'node:net';
import { whoisDomain } from 'whoiser';

import type { RdapDomain } from '../rdap/types.ts';
import { MAX_RESPONSE_BYTES, UPSTREAM_TIMEOUT_MS } from './config.ts';
import { emptyRecord, LookupError, type WhoisData } from './model.ts';
import { rdapRecord, whoisRecord, whoisTextError } from './normalize.ts';
import { subregistryRoute } from './registries.ts';
import { UpstreamScheduler } from './scheduler.ts';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const DISCOVERY_TTL = 24 * 60 * 60 * 1000;
type Bootstrap = { services: [string[], string[]][] };

export function retryAfterSeconds(header: string | null, now = Date.now()): number {
	if (header && /^\d+$/.test(header.trim())) {
		const seconds = Number(header);
		return Number.isSafeInteger(seconds) && seconds * 1000 < Number.MAX_SAFE_INTEGER
			? Math.max(1, seconds)
			: 60;
	}
	const date = header ? Date.parse(header) : NaN;
	return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 60;
}

function upstreamError(error: unknown, signal: AbortSignal): LookupError {
	if (error instanceof LookupError) return error;
	if (
		signal.aborted ||
		(error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
	) {
		return new LookupError('LOOKUP_TIMEOUT', 'The upstream registration request timed out.');
	}
	return new LookupError('LOOKUP_FAILED', 'The upstream registration server could not be reached.');
}

function contextError(error: unknown, signal: AbortSignal, context: string): LookupError {
	const cause = upstreamError(error, signal);
	return new LookupError(cause.code, `${context}: ${cause.message}`, cause.retryAfterSeconds);
}

function safeUrl(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		(url.port && url.port !== '443')
	) {
		throw new LookupError('LOOKUP_FAILED', 'The upstream returned an unsupported RDAP server URL.');
	}
	return url;
}

// Only discovered servers are accepted; clients cannot select a host or a port.
export class RegistrationProvider {
	private scheduler: UpstreamScheduler;
	private bootstrap?: { value: Bootstrap; expires: number };
	private bootstrapPending?: Promise<Bootstrap>;
	private whoisServers = new Map<string, { host: string | null; expires: number }>();
	private discoveryPending = new Map<string, Promise<string | null>>();

	constructor(scheduler: UpstreamScheduler) {
		this.scheduler = scheduler;
	}

	private async json(
		url: URL,
		signal: AbortSignal,
		redirects = 0,
	): Promise<{ status: number; data: unknown; server: string }> {
		const key = url.hostname.toLowerCase();
		return this.scheduler
			.run(key, signal, async () => {
				const timeout = AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
				try {
					const response = await fetch(url, {
						headers: { Accept: 'application/rdap+json, application/json' },
						cache: 'no-store',
						redirect: 'manual',
						signal: timeout,
					});
					if (response.status === 429) {
						await response.body?.cancel();
						const seconds = retryAfterSeconds(response.headers.get('retry-after'));
						this.scheduler.cooldown(key, seconds);
						throw new LookupError(
							'UPSTREAM_RATE_LIMITED',
							'The upstream RDAP server is rate limited. Retry later.',
							seconds,
						);
					}
					if ([301, 302, 303, 307, 308].includes(response.status)) {
						await response.body?.cancel();
						const location = response.headers.get('location');
						if (!location || redirects >= 3)
							throw new LookupError(
								'LOOKUP_FAILED',
								'The upstream RDAP redirect could not be followed.',
							);
						// Release this host's permit before acquiring the redirect host's permit.
						return {
							status: response.status,
							data: new URL(location, url).href,
							server: url.origin,
						};
					}
					if (response.status !== 200) {
						await response.body?.cancel();
						return { status: response.status, data: null, server: url.origin };
					}
					const chunks: Uint8Array[] = [];
					let size = 0;
					if (!response.body)
						throw new LookupError('LOOKUP_FAILED', 'The upstream returned an empty RDAP response.');
					const reader = response.body.getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							size += value.byteLength;
							if (size > MAX_RESPONSE_BYTES)
								throw new LookupError('LOOKUP_FAILED', 'The upstream RDAP response was too large.');
							chunks.push(value);
						}
					} finally {
						await reader.cancel();
					}
					return {
						status: 200,
						data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
						server: url.origin,
					};
				} catch (error) {
					throw upstreamError(error, timeout);
				}
			})
			.then(result =>
				typeof result.data === 'string' && result.status >= 300 && result.status < 400
					? this.json(safeUrl(result.data), signal, redirects + 1)
					: result,
			)
			.catch(error => {
				throw contextError(error, signal, `RDAP request to ${key}`);
			});
	}

	private async rdapServers(tld: string, signal: AbortSignal): Promise<string[]> {
		if (!this.bootstrap || this.bootstrap.expires <= Date.now()) {
			if (!this.bootstrapPending) {
				this.bootstrapPending = this.json(new URL(BOOTSTRAP_URL), signal)
					.then(result => {
						const data = result.data as Bootstrap | null;
						if (result.status !== 200 || !Array.isArray(data?.services))
							throw new LookupError('LOOKUP_FAILED', 'RDAP server discovery failed.');
						this.bootstrap = { value: data, expires: Date.now() + DISCOVERY_TTL };
						return data;
					})
					.catch(error => {
						throw contextError(error, signal, 'RDAP discovery via data.iana.org');
					})
					.finally(() => {
						this.bootstrapPending = undefined;
					});
			}
			await this.bootstrapPending;
		}
		return this.bootstrap!.value.services.find(([tlds]) => tlds.includes(tld))?.[1] ?? [];
	}

	private async rawWhois(host: string, query: string, signal: AbortSignal): Promise<string> {
		if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) {
			throw new LookupError('LOOKUP_FAILED', 'The upstream returned an invalid WHOIS referral.');
		}
		const key = host.toLowerCase();
		return this.scheduler
			.run(key, signal, async () => {
				const timeout = AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
				try {
					const raw = await new Promise<string>((resolve, reject) => {
						const chunks: Buffer[] = [];
						let size = 0;
						// Try both address families for this host within the same upstream deadline.
						const socket = connect(
							{
								host,
								port: 43,
								autoSelectFamily: true,
								autoSelectFamilyAttemptTimeout: 250,
								signal: timeout,
							},
							() => socket.write(`${query}\r\n`),
						);
						socket.on('data', (chunk: Buffer) => {
							size += chunk.byteLength;
							if (size > MAX_RESPONSE_BYTES)
								socket.destroy(
									new LookupError('LOOKUP_FAILED', 'The upstream WHOIS response was too large.'),
								);
							else chunks.push(chunk);
						});
						socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
						socket.on('error', reject);
						socket.on('close', hadError => {
							if (!hadError) resolve(Buffer.concat(chunks).toString('utf8'));
						});
					});
					const error = whoisTextError(raw);
					if (error) {
						if (error.code === 'UPSTREAM_RATE_LIMITED')
							this.scheduler.cooldown(key, error.retryAfterSeconds!);
						throw error;
					}
					return raw;
				} catch (error) {
					throw upstreamError(error, timeout);
				}
			})
			.catch(error => {
				throw contextError(error, signal, `WHOIS query to ${key}`);
			});
	}

	private async whoisServer(tld: string, signal: AbortSignal): Promise<string | null> {
		const cached = this.whoisServers.get(tld);
		if (cached && cached.expires > Date.now()) return cached.host;
		let pending = this.discoveryPending.get(tld);
		if (!pending) {
			pending = this.rawWhois('whois.iana.org', tld, signal)
				.then(raw => {
					if (raw.match(/^domain:[ \t]*(\S+)[ \t]*$/im)?.[1].toLowerCase() !== tld)
						throw new LookupError('LOOKUP_FAILED', 'WHOIS server discovery failed.');
					// A blank IANA "whois:" value must not consume the next line's
					// "status:" label as a hostname (for example, .uk has no WHOIS).
					const host = raw.match(/^whois:[ \t]*(\S+)[ \t]*$/im)?.[1].toLowerCase() ?? null;
					this.whoisServers.set(tld, { host, expires: Date.now() + DISCOVERY_TTL });
					return host;
				})
				.catch(error => {
					throw contextError(error, signal, `WHOIS discovery for .${tld}`);
				})
				.finally(() => this.discoveryPending.delete(tld));
			this.discoveryPending.set(tld, pending);
		}
		return pending;
	}

	async lookup(domain: string, signal: AbortSignal): Promise<WhoisData> {
		const route = subregistryRoute(domain);
		if (route) {
			if (route.host) return this.lookupWhois(domain, route.host, signal);
			throw new LookupError(
				'UNSUPPORTED_TLD',
				`No public RDAP or WHOIS service is configured for .${route.suffix}; registration status is unknown.`,
			);
		}
		const tld = domain.split('.').at(-1)!;
		let rdapError: unknown;
		try {
			const servers = await this.rdapServers(tld, signal);
			for (const server of servers) {
				try {
					const url = safeUrl(server);
					url.pathname = `${url.pathname.replace(/\/$/, '')}/domain/${domain}`;
					url.search = '';
					url.hash = '';
					const result = await this.json(url, signal);
					if (result.status === 404) return emptyRecord('rdap', result.server);
					if (result.status === 200) {
						try {
							return rdapRecord(domain, result.server, result.data as RdapDomain);
						} catch (error) {
							throw contextError(error, signal, `RDAP response from ${url.hostname}`);
						}
					}
					throw new LookupError(
						'LOOKUP_FAILED',
						`RDAP request to ${url.hostname} returned HTTP ${result.status}.`,
					);
				} catch (error) {
					if (
						error instanceof LookupError &&
						['UPSTREAM_RATE_LIMITED', 'BUSY'].includes(error.code)
					)
						throw error;
					rdapError = error;
				}
			}
		} catch (error) {
			if (error instanceof LookupError && ['UPSTREAM_RATE_LIMITED', 'BUSY'].includes(error.code))
				throw error;
			rdapError = error;
		}
		if (signal.aborted)
			throw new LookupError('LOOKUP_TIMEOUT', 'The registration lookup timed out.');
		try {
			const host = await this.whoisServer(tld, signal);
			if (!host) {
				if (rdapError) throw rdapError;
				throw new LookupError(
					'UNSUPPORTED_TLD',
					'No RDAP or WHOIS registration service is available for this suffix.',
				);
			}
			return await this.lookupWhois(domain, host, signal);
		} catch (error) {
			if (rdapError instanceof LookupError && error !== rdapError) {
				const cause = upstreamError(error, signal);
				throw new LookupError(
					cause.code,
					`${cause.message} RDAP attempt: ${rdapError.message}`,
					cause.retryAfterSeconds,
				);
			}
			throw error;
		}
	}

	private async lookupWhois(domain: string, host: string, signal: AbortSignal): Promise<WhoisData> {
		const errors: LookupError[] = [];
		const results = await whoisDomain(domain, {
			host,
			raw: true,
			follow: 2,
			whoisQuery: async (server, query) => {
				try {
					return await this.rawWhois(server, query, signal);
				} catch (error) {
					errors.push(upstreamError(error, signal));
					throw error;
				}
			},
		});
		try {
			return whoisRecord(domain, results);
		} catch (error) {
			throw (
				errors.find(error => error.code === 'UPSTREAM_RATE_LIMITED') ??
				errors[0] ??
				contextError(error, signal, `WHOIS response from ${host}`)
			);
		}
	}
}
