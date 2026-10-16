import { whoisOpenApi } from '@/lib/whois-api/openapi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
	return Response.json(whoisOpenApi(), { headers: { 'Cache-Control': 'no-store' } });
}
