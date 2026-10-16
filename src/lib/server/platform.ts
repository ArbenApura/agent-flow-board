// THE PLATFORM OF THE CURRENT REQUEST: THE BINDINGS A CLOUDFLARE WORKER IS GIVEN (HYPERDRIVE, R2, QUEUES, THE HUB), AND NOTHING ON A SERVER
// A Worker's bindings arrive with each request, and an object made from one (a database pool, a stream) must not outlive it. The
// request handler, the queue consumer and the cron handler each run their work inside `runWithPlatform`, and the code that needs a
// binding asks `currentPlatform()`. On a Node server there is no platform, so every function here does nothing.

// -- DEP-MODULES -- //
import { AsyncLocalStorage } from 'node:async_hooks';

// -- TYPES -- //

export type WorkerContext = { waitUntil(promise: Promise<unknown>): void };
export type Platform = { env: Record<string, unknown>; ctx?: WorkerContext };
type Store = { platform: Platform; scope: Map<string, unknown> };

// -- STATES -- //

const als = new AsyncLocalStorage<Store>();

// -- FUNCTIONS -- //

/** Runs `fn` with this platform. Without one (a Node server) it simply runs `fn`. */
export function runWithPlatform<T>(platform: Platform | undefined, fn: () => T): T {
	return platform ? als.run({ platform, scope: new Map() }, fn) : fn();
}

/** The bindings of the current request, or undefined on a Node server. */
export const currentPlatform = (): Platform | undefined => als.getStore()?.platform;

/** One value for the whole current request, made on first use. Without a platform it is made every time. */
export function requestScoped<T>(key: string, make: () => T): T {
	const store = als.getStore();
	if (!store) return make();
	if (!store.scope.has(key)) store.scope.set(key, make());
	return store.scope.get(key) as T;
}

/** Changes the request made, to be sent to the hub when the request is done and their transactions have committed. */
export function pendingChanges<T>(): T[] {
	return requestScoped<T[]>('pending-changes', () => []);
}
