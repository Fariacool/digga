import { KeyRound } from 'lucide-react';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import ApiKeyForm from '@/components/auth/api-key-form';
import StateNotice from '@/components/lookup/state-notice';
import { safeReturnPath } from '@/lib/auth-core';
import { isRequestAuthorized } from '@/lib/auth-server';
import { buildMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = buildMetadata({
	title: 'Unlock digga',
	path: '/unlock',
	noIndex: true,
});

export default async function UnlockPage({ searchParams }: PageProps<'/unlock'>) {
	const params = await searchParams;
	const returnTo = safeReturnPath(params.next);
	if (!process.env.API_KEY) redirect(returnTo);
	const authenticated = await isRequestAuthorized();
	if (authenticated) redirect(returnTo);

	return (
		<div className="mx-auto w-full max-w-2xl px-5 pt-10 pb-16 sm:pt-16">
			<StateNotice
				tone="neutral"
				titleAs="h1"
				icon={<KeyRound className="size-9" />}
				title="Unlock digga"
				description="This instance requires an API key. Enter the key provided by its owner to use the lookup tools."
			>
				<div className="w-full max-w-sm">
					<ApiKeyForm returnTo={returnTo} authenticated={authenticated} />
				</div>
			</StateNotice>
		</div>
	);
}
