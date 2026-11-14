// ISOLATED MOCKUP ORIGIN PARSING AND REQUEST GATING (STEP B.1, AFB-20261113-1008)
// Mockups are served from a second hostname (MOCKUP_ORIGIN) so session cookies on AFB_BASE_URL (host-only) are never
// sent to mockup pages, and requests hitting MOCKUP_ORIGIN can never reach board pages, APIs, OAuth or MCP.

// -- CONSTANTS -- //

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MOCKUP_SERVE_PATH = /^\/(mf|m)\//;

// -- TYPES -- //

export type MockupOriginStatus = {
	configured: boolean;
	devOnlySameHost: boolean;
	origin: string;
	notice: string | null;
};

// -- FUNCTIONS -- //

const isLoopbackHostname = (hostname: string) => {
	const lower = hostname.toLowerCase();
	return LOOPBACK_HOSTS.has(lower) || lower.endsWith('.localhost');
};

/** Validates optional MOCKUP_ORIGIN and rejects misconfigurations loudly. */
export function parseMockupOrigin(
	rawValue: string | undefined,
	boardBaseUrl?: string
): string | undefined {
	if (!rawValue || rawValue.trim() === '') return undefined;
	let parsed: URL;
	try {
		parsed = new URL(rawValue.trim());
	} catch {
		throw new Error('MOCKUP_ORIGIN must be a full origin such as https://mockups.example.com');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
		throw new Error('MOCKUP_ORIGIN must use https:// (or http:// on localhost only)');
	if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname))
		throw new Error('MOCKUP_ORIGIN must use https:// outside localhost');
	if (parsed.username || parsed.password)
		throw new Error('MOCKUP_ORIGIN must not contain credentials');
	if (parsed.pathname !== '/' || parsed.search || parsed.hash)
		throw new Error('MOCKUP_ORIGIN must be a bare origin with no path, query or hash');
	if (boardBaseUrl) {
		let board: URL;
		try {
			board = new URL(boardBaseUrl);
		} catch {
			throw new Error('AFB_BASE_URL must be valid before setting MOCKUP_ORIGIN');
		}
		if (parsed.origin.toLowerCase() === board.origin.toLowerCase())
			throw new Error('MOCKUP_ORIGIN must differ from AFB_BASE_URL');
		// Browsers scope host-only cookies by hostname without port, so same hostname on another port still shares cookies
		if (parsed.hostname.toLowerCase() === board.hostname.toLowerCase())
			throw new Error(
				'MOCKUP_ORIGIN must use a second hostname (changing only the port does not isolate browser cookies)'
			);
	}
	return parsed.origin;
}

/** Explicit local-development notice when MOCKUP_ORIGIN is unset. */
export function mockupOriginStatus(
	boardBaseUrl: string,
	mockupOrigin: string | undefined
): MockupOriginStatus {
	const boardOrigin = new URL(boardBaseUrl).origin;
	if (!mockupOrigin) {
		return {
			configured: false,
			devOnlySameHost: true,
			origin: boardOrigin,
			notice:
				'MOCKUP_ORIGIN is unset: serving sandboxed mockups from the same host for local development only.'
		};
	}
	return {
		configured: true,
		devOnlySameHost: false,
		origin: mockupOrigin,
		notice: null
	};
}

/** True when a request arrived at the configured second mockup hostname. */
export function isMockupOriginRequest(
	requestUrl: URL,
	hostHeader: string | null,
	mockupOrigin: string | undefined
): boolean {
	if (!mockupOrigin) return false;
	const target = new URL(mockupOrigin);
	if (requestUrl.origin.toLowerCase() === target.origin.toLowerCase()) return true;
	return Boolean(hostHeader && hostHeader.trim().toLowerCase() === target.host.toLowerCase());
}

/** Only signed member mockup files (/mf/...) and public mockup links (/m/...) may be served on MOCKUP_ORIGIN. */
export const isMockupServingPath = (pathname: string): boolean => MOCKUP_SERVE_PATH.test(pathname);

/** Paths carrying mockup/kit assets that are blocked on the main board origin whenever MOCKUP_ORIGIN is configured. */
export const isBlockedMainOriginMockupFilePath = (pathname: string): boolean =>
	/^\/(mf\/|m\/[^/]+\/(?:file(?:\/|$)|kit\/))/.test(pathname);

/** Prefixes a signed mockup path with MOCKUP_ORIGIN when configured, else leaves the relative local path. */
export const buildMockupUrl = (relativePath: string, mockupOrigin?: string): string =>
	mockupOrigin ? `${mockupOrigin}${relativePath}` : relativePath;
