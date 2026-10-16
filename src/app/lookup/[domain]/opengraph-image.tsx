import { withPrivateAuthHeaders } from '@/lib/auth-core';
import { requireApiAccess } from '@/lib/auth-server';
import { ogImageAlt, ogImageContentType, ogImageSize, renderDomainOgImage } from '@/lib/og-image';

export const alt = ogImageAlt;
export const size = ogImageSize;
export const contentType = ogImageContentType;

export default async function OgImage({ params }: { params: Promise<{ domain: string }> }) {
	const { domain } = await params;
	await requireApiAccess(`/lookup/${domain}`);
	const response = renderDomainOgImage(domain);
	return process.env.API_KEY ? withPrivateAuthHeaders(response) : response;
}
