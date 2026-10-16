import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { FC } from 'react';

import SubdomainScanner from '@/components/lookup/subdomain-scanner';
import { requireApiAccess } from '@/lib/auth-server';
import { getTLD, isValidLookupDomain, normalizeDomain } from '@/lib/domain';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { buildMetadata } from '@/lib/seo';

export async function generateMetadata({
	params,
}: PageProps<'/lookup/[domain]/subdomains'>): Promise<Metadata> {
	const { domain } = await params;
	await requireApiAccess(`/lookup/${domain}/subdomains`);
	const normalized = normalizeDomain(decodeURIComponent(domain));
	return buildMetadata({
		title: `Subdomains for ${normalized}`,
		description: `Passive subdomain finder for ${normalized}. Discover public subdomains from Certificate Transparency and other passive sources.`,
		path: `/lookup/${normalized}/subdomains`,
		noIndex: true,
		image: `/lookup/${normalized}/opengraph-image`,
	});
}

const SubdomainsPage: FC<PageProps<'/lookup/[domain]/subdomains'>> = async ({ params }) => {
	const { domain: raw } = await params;
	await requireApiAccess(`/lookup/${raw}/subdomains`);
	const domain = normalizeDomain(decodeURIComponent(raw));
	if (!isValidLookupDomain(domain)) notFound();

	// Pass only the public runtime key to the client; the secret stays server-side.
	return (
		<SubdomainScanner
			domain={domain}
			tld={getTLD(domain) ?? undefined}
			turnstileSiteKey={getRuntimeEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY') || undefined}
		/>
	);
};

export default SubdomainsPage;
