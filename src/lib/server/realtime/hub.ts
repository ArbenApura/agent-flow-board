// THE REALTIME HUB: ONE LISTENER ON THE DATABASE PER PROCESS, FANNED OUT TO THE OPEN STREAMS OF EACH PROJECT (SPEC 11, 12)
// On a VPS this is LISTEN and NOTIFY. On Cloudflare the same interface is served by a Durable Object (Phase 13).
// A null change means the listening connection was lost, so every stream tells its page to refetch.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Change } from './notify';
// -- MODULES -- //
import { workersHub, type HubNamespace } from '../cloudflare/hub';
import { currentPlatform, requestScoped } from '../platform';
import { CHANNEL } from './notify';

// -- TYPES -- //

export type Listener = (change: Change | null) => void;
export interface RealtimeHub {
	/** Calls `fn` for every change in the project. Returns the function that stops it. */
	subscribe(projectId: string, fn: Listener): () => void;
	/** Calls `fn` for every change in every project (background workers, never a page). */
	subscribeAll(fn: Listener): () => void;
	close(): Promise<void>;
}

// -- STATES -- //

const hubs = new WeakMap<DbHandle, Promise<RealtimeHub>>();

// -- FUNCTIONS -- //

async function start(handle: DbHandle): Promise<RealtimeHub> {
	const byProject = new Map<string, Set<Listener>>();
	const all = new Set<Listener>();
	const workers = new Set<Listener>();
	const stop = await handle.listen(CHANNEL, (payload) => {
		if (payload === '') {
			for (const fn of all) fn(null);
			return;
		}
		let change: Change;
		try {
			change = JSON.parse(payload) as Change;
		} catch {
			return;
		}
		for (const fn of byProject.get(change.p) ?? []) fn(change);
		for (const fn of workers) fn(change);
	});
	return {
		subscribe(projectId, fn) {
			let set = byProject.get(projectId);
			if (!set) byProject.set(projectId, (set = new Set()));
			set.add(fn);
			all.add(fn);
			return () => {
				set.delete(fn);
				all.delete(fn);
				if (!set.size) byProject.delete(projectId);
			};
		},
		subscribeAll(fn) {
			workers.add(fn);
			all.add(fn);
			return () => {
				workers.delete(fn);
				all.delete(fn);
			};
		},
		close: async () => {
			byProject.clear();
			workers.clear();
			all.clear();
			await stop();
		}
	};
}

/** The hub for this database, started on first use and shared by every stream of the process. */
export function getHub(handle: DbHandle): Promise<RealtimeHub> {
	// On a Worker the hub is the project's Durable Object, reached through the binding of the current request
	const binding = currentPlatform()?.env.AFB_HUB as HubNamespace | undefined;
	if (binding) return Promise.resolve(requestScoped('hub', () => workersHub(binding)));
	let hub = hubs.get(handle);
	if (!hub) {
		hub = start(handle);
		hubs.set(handle, hub);
		// A failed start is not kept, so the next stream tries again
		hub.catch(() => hubs.delete(handle));
	}
	return hub;
}
