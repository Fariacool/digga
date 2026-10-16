import { SITE_DESCRIPTION } from '@/lib/data';
import { siteUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
	const base = await siteUrl();
	const body = `# digga.dev

> ${SITE_DESCRIPTION}

digga is a free, open source domain and infrastructure research tool. Enter any domain, subdomain, or URL to inspect its DNS, registration, and subdomains. No signup, no paywall.

## What it does

- DNS records: A, AAAA, MX, NS, TXT, CAA, DNSKEY, DS, SOA, SRV, PTR, NAPTR, CNAME. Resolved live via Cloudflare, Google, or Alibaba DNS over HTTPS.
- RDAP: structured registration data (registrar, registrant, status, events, DNSSEC) queried through the IANA bootstrap registry.
- WHOIS: raw registration data as a fallback when a registry does not support RDAP.
- Subdomains: passive enumeration from public sources like Certificate Transparency logs. No traffic is sent to the target.
- IP intelligence: ASN, organization, country, and reverse DNS for every A and AAAA record.
- Email security: SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and BIMI checks with spoofing-protection analysis.

## Key pages

- [Home](${base}/): search entry point and overview of features.
- [Lookup overview](${base}/lookup/{domain}): registration, key dates, nameservers, status, DNS summary for a domain.
- [DNS records](${base}/lookup/{domain}/dns): every DNS record type with a resolver switch.
- [RDAP and WHOIS](${base}/lookup/{domain}/whois): registration data, RDAP first with WHOIS fallback.
- [Subdomains](${base}/lookup/{domain}/subdomains): passive subdomain discovery.
- [Email security](${base}/lookup/{domain}/email): SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and BIMI posture.
- [TLS certificate](${base}/lookup/{domain}/tls): live certificate issuer, validity window, expiry countdown, protocol, cipher, SANs, and chain.

Replace {domain} with any domain name, for example ${base}/lookup/example.com.

## Tool landing pages

- [DNS Lookup](${base}/dns): free DNS lookup for A, AAAA, MX, NS, TXT, CAA, SOA, SRV, and DNSSEC records.
- [WHOIS Lookup](${base}/whois): free WHOIS lookup for registrar, owner, dates, status, and nameservers.
- [RDAP Lookup](${base}/rdap): free RDAP lookup for structured domain registration data.
- [Subdomain Finder](${base}/subdomains): free passive subdomain discovery from Certificate Transparency logs.
- [Email Security Check](${base}/email): free SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and BIMI analysis.
- [SSL and TLS Certificate Checker](${base}/tls): free certificate issuer, expiry, protocol, cipher, and chain check.

## Facts

- License: AGPL 3.0, open source.
- Price: free for everyone.
- Source: https://github.com/maaaathis/digga
`;

	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=86400',
		},
	});
}
