import 'server-only';

import Script from 'next/script';
import type { FC } from 'react';

import { getRuntimeEnv } from '@/lib/runtime-env';

const Analytics: FC = () => {
	const src = getRuntimeEnv('NEXT_PUBLIC_ANALYTICS_SCRIPT');
	const id = getRuntimeEnv('NEXT_PUBLIC_ANALYTICS_ID');
	const domains = getRuntimeEnv('NEXT_PUBLIC_ANALYTICS_DOMAINS');

	if (!src || !id) return null;

	return (
		<Script
			src={src}
			data-website-id={id}
			data-domains={domains || undefined}
			strategy="afterInteractive"
		/>
	);
};

export default Analytics;
