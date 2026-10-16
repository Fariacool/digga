import Link from 'next/link';

import { buildMetadata } from '@/lib/seo';
import { whoisConfig } from '@/lib/whois-api/config';

import SwaggerReference from './swagger';

export function generateMetadata() {
	return buildMetadata({
		title: 'API reference',
		path: '/docs',
		description: 'WHOIS JSON API reference and interactive examples.',
	});
}

export default function DocsPage() {
	const { batchLimit } = whoisConfig();
	return (
		<div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
			<div className="border-border mb-10 flex flex-wrap items-end justify-between gap-6 border-b pb-8">
				<div>
					<p className="text-muted-foreground mb-3 font-mono text-xs tracking-widest uppercase">
						Developer reference
					</p>
					<h1 className="font-heading text-4xl tracking-tight md:text-5xl">
						Registration data, in JSON.
					</h1>
					<p className="text-muted-foreground mt-4 max-w-2xl text-sm leading-6">
						Query one domain or up to {batchLimit} at a time. These endpoints return WHOIS / RDAP
						registration data. Each digga tool has its own scope; only WHOIS is available by API
						today.
					</p>
				</div>
				<Link href="/openapi.json" className="text-sm underline underline-offset-4">
					OpenAPI 3.1 JSON ↗
				</Link>
			</div>
			<p className="text-muted-foreground mb-8 text-sm leading-6">
				Use <strong className="text-foreground font-medium">API key</strong> in the navigation to
				unlock this browser, or use{' '}
				<strong className="text-foreground font-medium">Authorize</strong> below for a Bearer token.
				When API_KEY is unset, requests are public. Tokens entered in this reference are kept only
				for this page session.
			</p>
			<SwaggerReference />
		</div>
	);
}
