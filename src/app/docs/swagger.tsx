'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { version } from 'swagger-ui-dist/package.json';

import 'swagger-ui-dist/swagger-ui.css';

import './swagger.css';

declare global {
	interface Window {
		SwaggerUIBundle?: (options: Record<string, unknown>) => void;
	}
}

export default function SwaggerReference() {
	const container = useRef<HTMLDivElement>(null);
	const [ready, setReady] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const node = container.current;
		if (!ready || !node || !window.SwaggerUIBundle) return;
		window.SwaggerUIBundle({
			domNode: node,
			url: '/openapi.json',
			deepLinking: true,
			docExpansion: 'list',
			defaultModelsExpandDepth: -1,
			displayRequestDuration: true,
			persistAuthorization: false,
			queryConfigEnabled: false,
			validatorUrl: null,
			withCredentials: true,
			supportedSubmitMethods: ['get', 'post'],
			onComplete: () => setLoaded(true),
		});
		return () => node.replaceChildren();
	}, [ready]);

	return (
		<div className="api-reference min-w-0">
			<Script
				src={`/vendor/swagger-ui/${version}/swagger-ui-bundle.js`}
				onReady={() => setReady(true)}
				onError={() => setFailed(true)}
			/>
			{!loaded && (
				<p className="text-muted-foreground py-8 text-sm" role="status">
					{failed
						? 'Could not load the API reference. You can download the OpenAPI JSON above.'
						: 'Loading API reference…'}
				</p>
			)}
			<div ref={container} />
		</div>
	);
}
