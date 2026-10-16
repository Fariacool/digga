function positiveInteger(value: string | undefined, fallback: number, max: number): number {
	if (!value || !/^\d+$/.test(value.trim())) return fallback;
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : fallback;
}

export function whoisConfig(env: Record<string, string | undefined> = process.env) {
	return {
		batchLimit: positiveInteger(env.WHOIS_BATCH_LIMIT, 10, 100),
		maxConcurrent: positiveInteger(env.WHOIS_MAX_CONCURRENT, 20, 200),
		perServerConcurrent: positiveInteger(env.WHOIS_PER_SERVER_CONCURRENT, 5, 200),
	};
}

export const CACHE_TTL_MS = 60 * 60 * 1000;
export const LOOKUP_TIMEOUT_MS = 30_000;
export const UPSTREAM_TIMEOUT_MS = 5000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
