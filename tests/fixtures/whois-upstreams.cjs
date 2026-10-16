// Loaded only by the test runner via --require. Production has no fixture switches.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const send = message => {
	if (process.connected) process.send(message);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
	if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return nativeFetch(input, init);
	const domain = url.pathname.split('/').at(-1);
	send({ type: 'fixture', protocol: 'rdap', host: url.hostname, domain });
	await delay(20, undefined, { signal: init?.signal });
	if (url.hostname === 'data.iana.org') {
		return Response.json({
			services: [
				[['com', 'uk', 'de'], ['https://rdap.fixture.example/']],
				[['net'], ['https://limited.fixture.example/']],
				[['au'], ['https://forbidden.fixture.example/']],
			],
		});
	}
	if (url.hostname === 'limited.fixture.example')
		return new Response('', { status: 429, headers: { 'Retry-After': '120' } });
	if (url.hostname === 'forbidden.fixture.example') return new Response('', { status: 403 });
	if (url.hostname === 'redirect.fixture.example') {
		return Response.json({ objectClassName: 'domain', ldhName: domain });
	}
	if (url.hostname !== 'rdap.fixture.example')
		throw new Error(`Unexpected external request: ${url.hostname}`);
	if (domain.startsWith('missing')) return new Response('', { status: 404 });
	if (domain.startsWith('timeout')) {
		await delay(6000, undefined, { signal: init?.signal });
		throw new Error('Fixture should have timed out');
	}
	if (domain.startsWith('fallback')) return new Response('', { status: 503 });
	if (domain.startsWith('redirect'))
		return new Response('', {
			status: 302,
			headers: { Location: `https://redirect.fixture.example/domain/${domain}` },
		});
	if (domain.startsWith('malformed')) return Response.json({ objectClassName: 'entity' });
	return Response.json({
		objectClassName: 'domain',
		ldhName: domain.toUpperCase(),
		status: ['active'],
		entities: [
			{
				objectClassName: 'entity',
				roles: ['registrar'],
				vcardArray: ['vcard', [['fn', {}, 'text', 'Fixture Registrar']]],
				publicIds: [{ type: 'IANA Registrar ID', identifier: '123' }],
			},
		],
		events: [{ eventAction: 'registration', eventDate: '2000-01-02T03:04:05Z' }],
		nameservers: [{ objectClassName: 'nameserver', ldhName: 'NS1.EXAMPLE.COM' }],
		secureDNS: { delegationSigned: false },
	});
};

const fixture = net.createServer(socket => {
	let buffer = '';
	socket.setEncoding('utf8');
	socket.on('data', chunk => {
		buffer += chunk;
		const lines = buffer.trim().split('\n');
		if (lines.length < 2) return;
		const host = lines[0].trim();
		const query = lines[1].trim();
		send({ type: 'fixture', protocol: 'whois', host, domain: query });
		if (host === 'whois.iana.org' && query === 'at') {
			socket.end('Query limit exceeded\n');
		} else if (host === 'whois.iana.org' && query === 'fr') {
			socket.end('domain: FR\nwhois:    \n\nstatus: ACTIVE\n');
		} else if (host === 'whois.iana.org' && ['pt', 'il', 'lv', 'pe', 'au', 'bg'].includes(query)) {
			const hosts = {
				pt: 'whois.dns.pt',
				il: 'whois.isoc.org.il',
				lv: 'whois.nic.lv',
				pe: 'kero.yachay.pe',
				au: 'whois.auda.org.au',
				bg: 'whois.register.bg',
			};
			socket.end(`domain: ${query.toUpperCase()}\nwhois: ${hosts[query]}\n`);
		} else if (host === 'whois.iana.org') {
			socket.end(`domain: ${query.toUpperCase()}\nwhois: whois.registry.example\n`);
		} else if (query.startsWith('timeout')) {
			// Intentionally leave the socket open; the actual transport must abort it.
		} else if (query.startsWith('malformed')) {
			socket.end('No useful data, please try again later.\n');
		} else if (query.startsWith('whois-rate')) {
			socket.end('Query limit exceeded\n');
		} else if (query.startsWith('denied')) {
			socket.end('Access denied\n');
		} else if (query.startsWith('missing')) {
			socket.end(`No match for "${query.toUpperCase()}".\n`);
		} else if (
			[
				'whois.dns.pt',
				'whois.ja.net',
				'whois.isoc.org.il',
				'whois.nic.lv',
				'kero.yachay.pe',
				'whois.auda.org.au',
				'whois.register.bg',
			].includes(host)
		) {
			const formats = {
				'whois.dns.pt': ['pt', 'example.pt'],
				'whois.ja.net': ['jisc', 'example.ac.uk'],
				'whois.isoc.org.il': ['il', 'example.co.il'],
				'whois.nic.lv': ['lv', 'example.lv'],
				'kero.yachay.pe': ['pe', 'example.com.pe'],
				'whois.auda.org.au': ['au', 'example.com.au'],
				'whois.register.bg': ['bg', 'example.bg'],
			};
			const [name, domain] = formats[host];
			socket.end(
				readFileSync(join(__dirname, 'whois', `${name}.txt`), 'utf8').replaceAll(domain, query),
			);
		} else {
			socket.end(
				`Domain Name: ${query.toUpperCase()}\nRegistrar: Fixture WHOIS Registrar\nRegistrar IANA ID: 456\nCreation Date: 2001-02-03T00:00:00Z\nRegistry Expiry Date: 2031-02-03T00:00:00Z\nName Server: NS2.EXAMPLE.ORG\nDNSSEC: unsigned\n${host === 'whois.registry.example' ? 'Registrar WHOIS Server: whois.registrar.example\n' : ''}`,
			);
		}
	});
	socket.on('error', () => {});
});
fixture.listen(0, '127.0.0.1');
fixture.unref();
const nativeConnect = net.connect;
net.connect = function (options, listener) {
	if (options && typeof options === 'object' && options.port === 43) {
		const address = fixture.address();
		const socket = nativeConnect({ ...options, host: '127.0.0.1', port: address.port }, () => {
			socket.write(`${options.host}\n`);
			listener?.();
		});
		return socket;
	}
	return nativeConnect.apply(this, arguments);
};
syncBuiltinESMExports();
