// A CLEAN SHUTDOWN, SO A DEPLOY NEVER CUTS A RUNNING AGENT OFF. INSTALLED ONCE WHEN THE SERVER STARTS (hooks.server.ts).
// On SIGTERM (docker stop) the adapter stops accepting connections and waits for the open requests, but a live-update stream never
// ends by itself, so without this the old process hangs until it is killed. Here every open stream is told to refetch and closed (the
// page reconnects after a second and replays from Last-Event-ID), the job workers finish what they are running, and once the adapter
// reports that every request is done the process exits.

// IMPORTED MODULES
import { stopJobs } from './jobs/index';

// -- CONSTANTS -- //

/** The longest a running job may take to finish. Docker's stop_grace_period (50 s) and the adapter's SHUTDOWN_TIMEOUT (40 s) are longer. */
const JOB_DRAIN_MS = 35_000;
/** Streams close at a random moment inside this window, so every page does not reconnect in the same instant. */
const SPREAD_MS = 500;

// -- STATES -- //

/** One function per open stream. Calling it sends the stream a final refetch and closes it. */
const streams = new Set<() => void>();
let installed = false;
let draining: Promise<void> | null = null;

// -- FUNCTIONS -- //

/** Registers an open stream. Returns the function that forgets it again. */
export function registerStream(goodbye: () => void): () => void {
	streams.add(goodbye);
	// A stream opened on a connection that was already open after the drain began is told to leave at once, or it would hold the
	// server open until the adapter closes every connection
	if (draining) leaveSoon(goodbye);
	return () => streams.delete(goodbye);
}

/** Runs one goodbye at a random moment inside the window. A failing goodbye is logged: an uncaught error in a timer would end the process and cut the job drain short. */
function leaveSoon(goodbye: () => void): void {
	setTimeout(() => {
		try {
			goodbye();
		} catch (e) {
			console.error('A stream could not be closed', e);
		}
	}, Math.random() * SPREAD_MS);
}

/** How many streams are open (for tests and logs). */
export function openStreams(): number {
	return streams.size;
}

/** Starts the drain once: streams out, jobs finished. Safe to call again. */
export function drain(): Promise<void> {
	draining ??= (async () => {
		for (const goodbye of [...streams]) leaveSoon(goodbye);
		try {
			await stopJobs(JOB_DRAIN_MS);
		} catch (e) {
			console.error('The job workers did not stop cleanly', e);
		}
	})();
	return draining;
}

/** Hooks SIGTERM and the adapter's own shutdown event. Called once; a second call does nothing. */
export function installShutdown(): void {
	if (installed) return;
	installed = true;
	// The adapter has its own SIGTERM handler (it stops accepting and waits for open requests). This one runs next to it
	process.on('SIGTERM', () => void drain());
	// The adapter emits this only after every request is finished, so the process can leave. Without it the open database
	// connections would keep the process alive until Docker kills it
	(process as NodeJS.EventEmitter).on('sveltekit:shutdown', () => {
		void drain().finally(() => process.exit(0));
	});
}
