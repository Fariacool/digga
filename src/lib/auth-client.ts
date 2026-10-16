'use client';

import { useSyncExternalStore } from 'react';

export const API_KEY_STORAGE_KEY = 'digga.api-key';
const CHANGE_EVENT = 'digga-api-key-change';

export function readApiKey(): string {
	try {
		return window.localStorage.getItem(API_KEY_STORAGE_KEY) ?? '';
	} catch {
		return '';
	}
}

export function saveApiKey(key: string): void {
	window.localStorage.setItem(API_KEY_STORAGE_KEY, key);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearApiKey(): void {
	window.localStorage.removeItem(API_KEY_STORAGE_KEY);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
	const storageChange = (event: StorageEvent) => {
		if (event.key === API_KEY_STORAGE_KEY || event.key === null) onChange();
	};
	window.addEventListener('storage', storageChange);
	window.addEventListener(CHANGE_EVENT, onChange);
	return () => {
		window.removeEventListener('storage', storageChange);
		window.removeEventListener(CHANGE_EVENT, onChange);
	};
}

export function useStoredApiKey(): string {
	return useSyncExternalStore(subscribe, readApiKey, () => '');
}

export function unlockWithApiKey(key: string): Promise<Response> {
	return fetch('/api/auth', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'same-origin',
		cache: 'no-store',
		body: JSON.stringify({ apiKey: key }),
	});
}
