import { isRequestAuthorized } from '@/lib/auth-server';
import {
	errorResponse,
	resultResponse,
	singleDomain,
	whoisUnauthorized,
} from '@/lib/whois-api/http';
import { failure } from '@/lib/whois-api/model';
import { whoisService } from '@/lib/whois-api/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
	if (!(await isRequestAuthorized())) return whoisUnauthorized();
	try {
		return resultResponse(await whoisService().lookup(singleDomain(request)));
	} catch (error) {
		return errorResponse(failure(error));
	}
}
