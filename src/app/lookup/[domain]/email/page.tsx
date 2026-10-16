import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { FC } from 'react';

import EmailSecurityReportView from '@/components/lookup/email-security-report';
import { requireApiAccess } from '@/lib/auth-server';
import { isValidLookupDomain, normalizeDomain } from '@/lib/domain';
import { analyzeEmailSecurity } from '@/lib/email-security';
import { shouldIndexLookup } from '@/lib/lookup-indexing';
import { buildMetadata } from '@/lib/seo';

export const fetchCache = 'default-no-store';

export async function generateMetadata({
	params,
}: PageProps<'/lookup/[domain]/email'>): Promise<Metadata> {
	const { domain } = await params;
	await requireApiAccess(`/lookup/${domain}/email`);
	const normalized = normalizeDomain(decodeURIComponent(domain));
	return buildMetadata({
		title: `Email security for ${normalized}`,
		description: `Email security check for ${normalized}. Analyze SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and BIMI to spot spoofing and deliverability risks.`,
		path: `/lookup/${normalized}/email`,
		noIndex: !(await shouldIndexLookup(normalized)),
		image: `/lookup/${normalized}/opengraph-image`,
	});
}

const EmailPage: FC<PageProps<'/lookup/[domain]/email'>> = async ({ params }) => {
	const { domain: raw } = await params;
	await requireApiAccess(`/lookup/${raw}/email`);
	const domain = normalizeDomain(decodeURIComponent(raw));
	if (!isValidLookupDomain(domain)) notFound();

	const report = await analyzeEmailSecurity(domain);

	return <EmailSecurityReportView report={report} />;
};

export default EmailPage;
