// SAVING A NOTE WHILE SOMEONE TYPES (AFB-20261111-0035, STEP 4.3)
// Pure scheduling with no Svelte and no network: the page hands it a send function. The text it holds is never dropped
// until the server has taken it, so a failed save, a conflict or a lost connection never costs the person their typing.

// -- TYPES -- //

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'offline' | 'conflict';

export interface SaveRequest {
	markdown: string;
	title: string;
	expectVersion: number;
}

export interface SaverOptions {
	/** The version of the note the editor was opened on. */
	version: number;
	/** Writes the note and answers with its new version. Throws when the server refuses. */
	send: (req: SaveRequest) => Promise<{ version: number }>;
	/** True when the error means the note moved on since the version we hold. */
	isConflict: (error: unknown) => boolean;
	isOnline?: () => boolean;
	onStatus?: (status: SaveStatus, error?: unknown) => void;
	/** Milliseconds of quiet after the last change before it is sent. */
	debounceMs?: number;
	/** Milliseconds to wait before each retry of a failed save; the last one repeats. */
	retryMs?: number[];
	timers?: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (id: unknown) => void;
	};
}

// -- CONSTANTS -- //

export const SAVE_DEBOUNCE_MS = 2000;
const RETRY_MS = [3000, 6000, 12_000, 30_000];

// -- FUNCTIONS -- //

export class Saver {
	status: SaveStatus = 'saved';
	/** The newest text the person has typed, whether or not it is saved yet. */
	markdown: string;
	title: string;

	private version: number;
	private savedMarkdown: string;
	private savedTitle: string;
	private inFlight = false;
	private timer: unknown = null;
	private attempt = 0;
	private disposed = false;
	private readonly o: SaverOptions;

	constructor(o: SaverOptions, text: { markdown: string; title: string }) {
		this.o = o;
		this.version = o.version;
		this.markdown = this.savedMarkdown = text.markdown;
		this.title = this.savedTitle = text.title;
	}

	/** The version the next save expects. */
	get currentVersion() {
		return this.version;
	}

	/** True while there is text the server has not taken. */
	get unsaved() {
		return this.markdown !== this.savedMarkdown || this.title !== this.savedTitle;
	}

	/** The person typed. Starts or restarts the quiet period. */
	change(next: { markdown?: string; title?: string }) {
		if (this.disposed) return;
		if (next.markdown !== undefined) this.markdown = next.markdown;
		if (next.title !== undefined) this.title = next.title;
		if (this.status === 'conflict') return;
		if (!this.unsaved && !this.inFlight) {
			this.clear();
			this.set('saved');
			return;
		}
		// While a save is on its way, its answer decides what happens next
		if (this.inFlight) return;
		this.set('pending');
		this.schedule(this.o.debounceMs ?? SAVE_DEBOUNCE_MS);
	}

	/** Sends now, for leaving the page or the Save now key. Does nothing when everything is saved. */
	async flush() {
		if (this.disposed || this.status === 'conflict' || !this.unsaved) return;
		this.clear();
		await this.run();
	}

	/** The connection is back: a save that was waiting goes out at once. */
	online() {
		if (this.disposed) return;
		if ((this.status === 'offline' || this.status === 'error') && this.unsaved) {
			this.clear();
			void this.run();
		}
	}

	/** After a conflict the person kept their own text: save it over the newer version, which is now the one we hold. */
	keepMine(version: number) {
		if (this.disposed) return;
		this.version = version;
		this.attempt = 0;
		this.set('pending');
		this.schedule(0);
	}

	/** After a conflict the person took the newer version: it is the saved state now and the typed text is replaced by it. */
	takeTheirs(next: { version: number; markdown: string; title: string }) {
		if (this.disposed) return;
		this.clear();
		this.version = next.version;
		this.markdown = this.savedMarkdown = next.markdown;
		this.title = this.savedTitle = next.title;
		this.attempt = 0;
		this.set('saved');
	}

	dispose() {
		this.disposed = true;
		this.clear();
	}

	// -- INSIDE -- //

	private set(status: SaveStatus, error?: unknown) {
		this.status = status;
		this.o.onStatus?.(status, error);
	}

	private schedule(ms: number) {
		this.clear();
		const set = this.o.timers?.set ?? ((fn, t) => setTimeout(fn, t));
		this.timer = set(() => {
			this.timer = null;
			void this.run();
		}, ms);
	}

	private clear() {
		if (this.timer === null) return;
		(this.o.timers?.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)))(
			this.timer
		);
		this.timer = null;
	}

	private async run() {
		if (this.disposed || this.inFlight || !this.unsaved) return;
		if (this.o.isOnline && !this.o.isOnline()) {
			this.set('offline');
			return;
		}
		const sent = { markdown: this.markdown, title: this.title };
		this.inFlight = true;
		this.set('saving');
		try {
			const res = await this.o.send({ ...sent, expectVersion: this.version });
			this.inFlight = false;
			if (this.disposed) return;
			this.version = res.version;
			this.savedMarkdown = sent.markdown;
			this.savedTitle = sent.title;
			this.attempt = 0;
			if (this.unsaved) {
				// More was typed while this went out
				this.set('pending');
				this.schedule(this.o.debounceMs ?? SAVE_DEBOUNCE_MS);
			} else this.set('saved');
		} catch (e) {
			this.inFlight = false;
			if (this.disposed) return;
			if (this.o.isConflict(e)) {
				this.clear();
				this.set('conflict', e);
			} else if (this.o.isOnline && !this.o.isOnline()) {
				this.set('offline', e);
			} else {
				this.set('error', e);
				const wait = this.o.retryMs ?? RETRY_MS;
				const ms = wait[Math.min(this.attempt, wait.length - 1)];
				this.attempt++;
				this.schedule(ms);
			}
		}
	}
}

/** The words under the editor for a status. */
export function saveLine(status: SaveStatus): string {
	switch (status) {
		case 'saved':
			return 'Saved';
		case 'pending':
		case 'saving':
			return 'Saving...';
		case 'offline':
			return 'Offline, will save when you are back';
		case 'conflict':
			return 'Not saved, someone else changed this note';
		case 'error':
			return 'Could not save, trying again';
	}
}
