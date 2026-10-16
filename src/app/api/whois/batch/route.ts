import { isRequestAuthorized } from '@/lib/auth-server';
import { whoisConfig } from '@/lib/whois-api/config';
import { apiJson, batchDomains, errorResponse, whoisUnauthorized } from '@/lib/whois-api/http';
import { failure } from '@/lib/whois-api/model';
import { whoisService } from '@/lib/whois-api/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
	if (!(await isRequestAuthorized())) return whoisUnauthorized();
	try {
		const domains = await batchDomains(request, whoisConfig().batchLimit);
		return apiJson(await whoisService().batch(domains));
	} catch (error) {
		return errorResponse(failure(error));
	}
}
