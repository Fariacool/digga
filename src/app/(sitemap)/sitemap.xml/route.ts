import { siteUrl } from '@/lib/seo';
import { renderSitemapIndex, XML_RESPONSE_HEADERS } from '@/lib/sitemap';

export const dynamic = 'force-dynamic';

export async function GET() {
	const base = await siteUrl();

	const sitemaps = [{ loc: `${base}/sitemap-pages.xml` }, { loc: `${base}/sitemap-common.xml` }];

	return new Response(renderSitemapIndex(sitemaps), { headers: XML_RESPONSE_HEADERS });
}
