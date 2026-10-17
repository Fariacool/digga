import { CACHE_TTL_MS, LOOKUP_TIMEOUT_MS } from './config.ts';
import { deadlineExpired, deadlineSignal } from './deadline.ts';
import {
	failure,
	LookupError,
	normalizeLookupDomain,
	type WhoisData,
	type WhoisResult,
} from './model.ts';

type Entry = { data: WhoisData; fetchedAt: number };
export type WhoisProvider = (domain: string, signal: AbortSignal) => Promise<WhoisData>;

export class WhoisService {
	private entries = new Map<string, Entry>();
	private inflight = new Map<string, Promise<Entry>>();
	private provider: WhoisProvider;
	private now: () => number;
	private ttl: number;

	constructor(provider: WhoisProvider, now = Date.now, ttl = CACHE_TTL_MS) {
		this.provider = provider;
		this.now = now;
		this.ttl = ttl;
	}

	async lookup(input: string): Promise<WhoisResult> {
		const started = this.now();
		let domain: string | null = null;
		try {
			domain = normalizeLookupDomain(input);
			let entry = this.entries.get(domain);
			const cached = Boolean(entry && started - entry.fetchedAt < this.ttl);
			if (!cached) {
				this.entries.delete(domain);
				let pending = this.inflight.get(domain);
				if (!pending) {
					if (this.inflight.size >= 200) {
						throw new LookupError('BUSY', 'The lookup queue is full. Retry later.', 1);
					}
					const key = domain;
					const signal = deadlineSignal(LOOKUP_TIMEOUT_MS);
					pending = this.provider(key, signal)
						.then(data => {
							if (deadlineExpired(signal))
								throw new LookupError('LOOKUP_TIMEOUT', 'The registration lookup timed out.');
							const result = { data, fetchedAt: this.now() };
							if (this.entries.size >= 2000) this.entries.delete(this.entries.keys().next().value!);
							this.entries.set(key, result);
							return result;
						})
						.finally(() => this.inflight.delete(key));
					this.inflight.set(key, pending);
				}
				entry = await pending;
			}
			return {
				ok: true,
				input,
				domain,
				data: entry!.data,
				meta: {
					cached,
					fetchedAt: new Date(entry!.fetchedAt).toISOString(),
					expiresAt: new Date(entry!.fetchedAt + this.ttl).toISOString(),
					durationMs: Math.max(0, this.now() - started),
				},
			};
		} catch (error) {
			return failure(error, input, domain);
		}
	}

	async batch(domains: string[]) {
		const results = await Promise.all(domains.map(domain => this.lookup(domain)));
		const succeeded = results.filter(result => result.ok).length;
		return {
			ok: true as const,
			results,
			summary: { total: results.length, succeeded, failed: results.length - succeeded },
		};
	}
}
