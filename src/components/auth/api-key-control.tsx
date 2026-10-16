'use client';

import { KeyRound, LockKeyholeOpen } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import useSWR from 'swr';

import ApiKeyForm from '@/components/auth/api-key-form';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@/components/ui/dialog';
import { readApiKey, unlockWithApiKey } from '@/lib/auth-client';

type AuthStatus = { enabled: boolean; authenticated: boolean; restored?: boolean };

async function fetchStatus(url: string): Promise<AuthStatus> {
	const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
	if (!response.ok) throw new Error('Could not load access status');
	const status: AuthStatus = await response.json();
	const key = readApiKey();
	if (status.enabled && !status.authenticated && key) {
		const restored = await unlockWithApiKey(key);
		if (restored.ok) {
			// A lock in another tab must not be undone by an in-flight restoration.
			if (!readApiKey()) {
				await fetch(url, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
				return status;
			}
			// Only reload after confirming that the browser actually accepted the cookie.
			const confirmation = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
			if (confirmation.ok) {
				const confirmed: AuthStatus = await confirmation.json();
				if (confirmed.authenticated) return { ...confirmed, restored: true };
			}
		}
	}
	return status;
}

export default function ApiKeyControl() {
	const pathname = usePathname();
	const { data } = useSWR('/api/auth', fetchStatus, { revalidateOnFocus: true });
	useEffect(() => {
		if (data?.restored) window.location.reload();
	}, [data?.restored]);
	if (!data?.enabled) return null;
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					aria-label="API key"
					title={data.authenticated ? 'Access unlocked' : 'API key'}
				>
					{data.authenticated ? (
						<LockKeyholeOpen className="size-4" />
					) : (
						<KeyRound className="size-4" />
					)}
					<span className="hidden sm:inline">API key</span>
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{data.authenticated ? 'Access unlocked' : 'Unlock digga'}</DialogTitle>
					<DialogDescription>
						{data.authenticated
							? 'You can use this instance in this browser. Lock it when you are done.'
							: 'Enter the API key provided by this instance’s owner to use the lookup tools.'}
					</DialogDescription>
				</DialogHeader>
				<ApiKeyForm
					returnTo={pathname === '/unlock' ? '/' : pathname}
					authenticated={data.authenticated}
				/>
			</DialogContent>
		</Dialog>
	);
}
