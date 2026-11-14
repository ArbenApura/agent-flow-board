// LIVE-SITE REGISTRATIONS: A REGISTRATION WITH A URL AND NO REPO. NOTHING IS BUILT OR STARTED; THE RUN IS UNVERIFIED AND NEVER WRITES.
// This file only judges the settings (url and extraHosts) and hands the guard its options. Writes are never allowed on a live site: a check
// there drives pages and reads, and the guard stops every POST, PUT, PATCH and DELETE.

// IMPORTED MODULES
import { FORBIDDEN_PORTS } from './guardrails.js';

// -- TYPES -- //

/** The two settings of a live site, from a Registration or a ProjectConfig. */
export type LiveSite = { url?: string; extraHosts?: string[] };

// -- CONSTANTS -- //

const MAX_EXTRA_HOSTS = 16;
/** A plain DNS name: dot separated labels of letters, digits and dashes. No wildcard, port, path or underscore. */
const HOST_NAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_HOSTS = new Set([
	'localhost',
	'127.0.0.1',
	'[::1]',
	'::1',
	'0.0.0.0',
	'host.docker.internal'
]);

// -- FUNCTIONS -- //

const isLoopbackName = (h: string) =>
	LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::]';
/** True for a dotted IPv4 address (also the short and number forms a browser accepts) or anything holding a colon (IPv6). */
const isIpLiteral = (h: string) =>
	h.includes(':') || h.startsWith('[') || /^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);

/** One plain sentence per problem with the live-site settings. An empty list means they are acceptable. */
export function liveSiteProblems(cfg: LiveSite): string[] {
	const problems: string[] = [];
	if (cfg.url !== undefined) {
		let u: URL | null = null;
		try {
			u = new URL(String(cfg.url));
		} catch {
			problems.push('The site address is not a web address.');
		}
		if (u) {
			if (u.protocol !== 'http:' && u.protocol !== 'https:')
				problems.push('The site address must start with http:// or https://.');
			else {
				if (u.username || u.password)
					problems.push('The site address may not hold a user name or password.');
				const host = u.hostname.toLowerCase();
				if (isLoopbackName(host)) {
					const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
					if (FORBIDDEN_PORTS.has(port))
						problems.push(`The site address uses port ${port}, which a check never uses.`);
				}
			}
		}
	}
	const extra = cfg.extraHosts ?? [];
	if (!Array.isArray(extra)) return [...problems, 'The extra hosts must be a list of host names.'];
	if (extra.length > MAX_EXTRA_HOSTS)
		problems.push(`At most ${MAX_EXTRA_HOSTS} extra hosts are allowed.`);
	for (const raw of extra) {
		const h = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
		const shown = typeof raw === 'string' ? raw.slice(0, 60) : String(typeof raw);
		if (!h || (!HOST_NAME.test(h) && !isIpLiteral(h)))
			problems.push(
				`The extra host "${shown}" is not an exact host name (no wildcard, port, path or address).`
			);
		else if (isIpLiteral(h))
			problems.push(`The extra host "${shown}" is an IP address. Only host names are allowed.`);
		else if (isLoopbackName(h))
			problems.push(`The extra host "${shown}" is this machine, which is never an extra host.`);
	}
	return problems;
}

/** What the child's guard is given for a live site: writes never allowed, and only the exact extra hosts reachable besides the site. */
export function liveSiteGuardOptions(cfg: LiveSite): { allowWrites: false; extraHosts: string[] } {
	const bad = liveSiteProblems(cfg);
	if (bad.length) throw new Error(bad[0]);
	return {
		allowWrites: false,
		extraHosts: [...new Set((cfg.extraHosts ?? []).map((h) => h.trim().toLowerCase()))]
	};
}

/** True when the settings describe a live site (a url and no repo to build). */
export const isLiveSite = (cfg: { url?: string }): boolean =>
	typeof cfg.url === 'string' && cfg.url !== '';
