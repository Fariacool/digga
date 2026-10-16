'use client';

import { Loader2, LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { clearApiKey, saveApiKey, unlockWithApiKey, useStoredApiKey } from '@/lib/auth-client';

export default function ApiKeyForm({
	returnTo,
	authenticated = false,
}: {
	returnTo: string;
	authenticated?: boolean;
}) {
	const id = useId();
	const storedKey = useStoredApiKey();
	const [draft, setDraft] = useState<string | null>(null);
	const key = draft ?? storedKey;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending(true);
		setError('');
		try {
			const response = await unlockWithApiKey(key.trim());
			if (!response.ok) {
				setError(
					response.status === 401
						? 'Invalid API key. Please try again.'
						: 'Could not unlock digga. Please try again.',
				);
				return;
			}
			try {
				saveApiKey(key.trim());
			} catch {
				setError('Access unlocked, but the API key could not be saved in this browser.');
				return;
			}
			setDraft('');
			// A full navigation also clears previously cached React Server Component data.
			window.location.replace(returnTo);
		} catch {
			setError('Could not connect. Please try again.');
		} finally {
			setPending(false);
		}
	}

	async function lock() {
		setPending(true);
		setError('');
		try {
			try {
				clearApiKey();
			} catch {
				setError('The saved API key could not be cleared in this browser.');
				return;
			}
			const response = await fetch('/api/auth', {
				method: 'DELETE',
				credentials: 'same-origin',
				cache: 'no-store',
			});
			if (!response.ok) {
				setError('Could not lock digga. Please try again.');
				return;
			}
			setDraft('');
			window.location.replace('/');
		} catch {
			setError('Could not connect. Please try again.');
		} finally {
			setPending(false);
		}
	}

	return (
		<form
			method="post"
			action="/api/auth"
			onSubmit={submit}
			className="w-full space-y-5 text-left"
			aria-busy={pending}
		>
			<div className="space-y-2">
				<label htmlFor={id} className="text-sm font-medium">
					API key
				</label>
				<Input
					id={id}
					name="api-key"
					type="password"
					autoComplete="off"
					spellCheck={false}
					autoCapitalize="none"
					required
					value={key}
					onChange={event => setDraft(event.target.value)}
					disabled={pending}
					aria-invalid={Boolean(error)}
					aria-describedby={error ? `${id}-error` : undefined}
					className="h-11 px-4"
				/>
				<p className="text-muted-foreground text-xs">Saved in this browser until you click Lock.</p>
			</div>
			{error && (
				<p id={`${id}-error`} role="alert" className="text-destructive text-sm">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button type="submit" disabled={pending || !key.trim()} className="h-11 flex-1">
					{pending ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<UnlockKeyhole className="size-4" />
					)}
					Unlock
				</Button>
				{(authenticated || storedKey) && (
					<Button
						type="button"
						variant="outline"
						disabled={pending}
						onClick={lock}
						className="h-11"
					>
						<LockKeyhole className="size-4" />
						Lock
					</Button>
				)}
			</div>
		</form>
	);
}
