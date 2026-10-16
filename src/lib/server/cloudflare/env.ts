// THE BINDINGS OF THE CURRENT WORKER REQUEST, FROM THE RUNTIME'S OWN MODULE (SPEC 4)
// adapter-cloudflare no longer puts the bindings on `event.platform`. A Worker reads them from the built in `cloudflare:workers`
// module, and a Node server has no such module, so it is loaded by name at run time only where it exists.

// -- TYPES -- //
import type { Platform } from '../platform';

// -- CONSTANTS -- //

const MODULE = 'cloudflare:workers';

// -- FUNCTIONS -- //

/** True inside a Cloudflare Worker. */
export const onWorkers = () =>
	typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

/** The bindings and `waitUntil` of this Worker, or undefined on a Node server. */
export async function workersPlatform(): Promise<Platform | undefined> {
	if (!onWorkers()) return undefined;
	const mod = (await import(/* @vite-ignore */ MODULE)) as {
		env: Record<string, unknown>;
		waitUntil(promise: Promise<unknown>): void;
	};
	return { env: mod.env, ctx: { waitUntil: (p) => mod.waitUntil(p) } };
}
