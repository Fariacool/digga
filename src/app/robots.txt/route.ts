import { siteUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
	const base = await siteUrl();
	const body = `User-agent: *
Allow: /
Disallow: /api/
Content-Signal: ai-train=yes, search=yes, ai-input=yes

Sitemap: ${base}/sitemap.xml
Host: ${base}
`;

	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=86400',
		},
	});
}
