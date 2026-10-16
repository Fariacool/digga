import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { SEO_KEYWORDS, SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from '@/lib/data';
import { resolveSiteOrigin } from '@/lib/site-origin';
import { TOOLS, type ToolSlug } from '@/lib/tools';

export async function siteUrl(): Promise<string> {
	const configuredUrl = process.env.SITE_URL?.trim();
	// Explicit overrides also work outside a request, such as background jobs.
	if (configuredUrl) return resolveSiteOrigin(new Headers(), configuredUrl);
	return resolveSiteOrigin(await headers());
}

export async function absoluteUrl(path: string): Promise<string> {
	if (path.startsWith('http')) return path;
	const base = await siteUrl();
	return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

export async function buildMetadata({
	title,
	description = SITE_DESCRIPTION,
	path,
	keywords,
	noIndex,
	image,
}: {
	title: string;
	description?: string;
	path: string;
	keywords?: readonly string[];
	noIndex?: boolean;
	image?: string;
}): Promise<Metadata> {
	const url = await absoluteUrl(path);
	const imageUrl = image ? await absoluteUrl(image) : undefined;
	return {
		title,
		description,
		keywords: keywords ? [...new Set([...keywords, ...SEO_KEYWORDS])] : [...SEO_KEYWORDS],
		alternates: { canonical: url },
		openGraph: {
			type: 'website',
			title,
			description,
			url,
			siteName: SITE_NAME,
			...(imageUrl ? { images: imageUrl } : {}),
		},
		twitter: {
			card: 'summary_large_image',
			title,
			description,
			...(imageUrl ? { images: imageUrl } : {}),
		},
		robots: noIndex ? 'noindex, nofollow' : 'index, follow',
	};
}

export function rootMetadata(): Promise<Metadata> {
	return buildMetadata({
		title: `${SITE_NAME} · ${SITE_TAGLINE}`,
		path: '/',
	});
}

export function toolMetadata(slug: ToolSlug): Promise<Metadata> {
	const tool = TOOLS[slug];
	return buildMetadata({
		title: tool.title,
		description: tool.description,
		path: `/${tool.slug}`,
		keywords: tool.keywords,
	});
}
