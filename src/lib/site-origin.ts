function firstHeader(value: string | null): string {
	return value?.split(',')[0]?.trim() ?? '';
}

function httpOrigin(value: string): string {
	const url = new URL(value);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new Error('Site origin must be an HTTP(S) origin without credentials or a path.');
	}
	return url.origin;
}

export function resolveSiteOrigin(
	requestHeaders: Pick<Headers, 'get'>,
	configuredUrl?: string,
): string {
	const override = configuredUrl?.trim();
	if (override) return httpOrigin(override);

	const host =
		firstHeader(requestHeaders.get('x-forwarded-host')) || firstHeader(requestHeaders.get('host'));
	if (!host || /[\s/\\?#@]/.test(host)) {
		throw new Error('Cannot determine site origin: a valid request Host is required.');
	}
	const forwardedProtocol = firstHeader(requestHeaders.get('x-forwarded-proto')).toLowerCase();
	const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
	return httpOrigin(`${protocol}://${host}`);
}
