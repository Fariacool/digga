import { NextResponse } from 'next/server';

import { withPrivateAuthHeaders } from '@/lib/auth-core';
import { apiAccessError } from '@/lib/auth-server';
import { cleanForLookup } from '@/lib/domain';

export const dynamic = 'force-dynamic';

/**
 * Entry point for the iOS Shortcut and other share integrations. The current
 * page URL is percent-encoded and then base64-encoded by the caller, e.g.
 * `/api/from/base64/<base64(encodeURIComponent(url))>`. We decode it, pull out
 * the hostname and redirect to the matching lookup page.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ data?: string[] }> }) {
	const denied = await apiAccessError();
	if (denied) return denied;
	const redirect = (target: string) => {
		const response = new NextResponse(null, { status: 307, headers: { Location: target } });
		return process.env.API_KEY ? withPrivateAuthHeaders(response) : response;
	};
	const { data } = await params;
	const encoded = (data ?? []).join('/');

	const home = '/';
	if (!encoded) return redirect(home);

	let decoded: string;
	try {
		const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
		decoded = Buffer.from(normalized, 'base64').toString('utf8');
	} catch {
		return redirect(home);
	}

	let candidate = decoded;
	try {
		candidate = decodeURIComponent(decoded);
	} catch {
		// Not valid percent-encoding — fall back to the raw decoded value.
	}

	const domain = cleanForLookup(candidate);
	if (!domain) return redirect(home);

	return redirect(`/lookup/${domain}`);
}
