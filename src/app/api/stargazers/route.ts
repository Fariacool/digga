import { NextResponse } from 'next/server';

import { withPrivateAuthHeaders } from '@/lib/auth-core';
import { apiAccessError } from '@/lib/auth-server';

const REPO = 'maaaathis/digga';
const RECENT_COUNT = 4;
const PER_PAGE = 100;

export const revalidate = 3600;

export type Stargazer = { name: string; avatarUrl: string };
export type StargazersSummary = { totalStars: number; recentStargazers: Stargazer[] };

type RawStargazer = { user?: { login?: string; avatar_url?: string } };

const EMPTY: StargazersSummary = { totalStars: 0, recentStargazers: [] };

function jsonSummary(value: StargazersSummary) {
	const response = NextResponse.json(value);
	return process.env.API_KEY ? withPrivateAuthHeaders(response) : response;
}

function githubHeaders(accept: string): HeadersInit {
	const headers: Record<string, string> = {
		'Accept': accept,
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'digga',
	};
	const token = process.env.GITHUB_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

async function fetchStargazerPage(page: number): Promise<RawStargazer[]> {
	const res = await fetch(
		`https://api.github.com/repos/${REPO}/stargazers?per_page=${PER_PAGE}&page=${page}`,
		{ headers: githubHeaders('application/vnd.github.star+json'), next: { revalidate } },
	);
	if (!res.ok) return [];
	return (await res.json()) as RawStargazer[];
}

export async function GET() {
	const denied = await apiAccessError();
	if (denied) return denied;
	try {
		const repoRes = await fetch(`https://api.github.com/repos/${REPO}`, {
			headers: githubHeaders('application/vnd.github+json'),
			next: { revalidate },
		});
		if (!repoRes.ok) return jsonSummary(EMPTY);

		const repo = (await repoRes.json()) as { stargazers_count?: number };
		const totalStars = repo.stargazers_count ?? 0;
		if (totalStars === 0) return jsonSummary(EMPTY);

		const lastPage = Math.max(1, Math.ceil(totalStars / PER_PAGE));
		let items = await fetchStargazerPage(lastPage);
		if (items.length < RECENT_COUNT && lastPage > 1) {
			const previous = await fetchStargazerPage(lastPage - 1);
			items = [...previous, ...items];
		}

		const recentStargazers: Stargazer[] = items
			.slice(-RECENT_COUNT)
			.reverse()
			.map(entry => ({ name: entry.user?.login ?? '', avatarUrl: entry.user?.avatar_url ?? '' }))
			.filter(stargazer => stargazer.name && stargazer.avatarUrl);

		return jsonSummary({ totalStars, recentStargazers });
	} catch {
		return jsonSummary(EMPTY);
	}
}
