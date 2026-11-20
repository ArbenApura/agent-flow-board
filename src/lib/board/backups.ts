// THE BACKUPS PAGE HELPERS: READABLE SIZES AND TIMES, FOLDING RUNS OF THE SAME FAILURE, AND THE DOWNLOAD THAT REPORTS REAL PROGRESS

// -- TYPES -- //

export type BackupRunView = {
	id: string;
	state: string;
	size: number | null;
	error: string | null;
	hasFile: boolean;
	createdAt: string | Date;
};

/** One row of the history: a good copy, or one or more failed runs that share a reason. */
export type RunRow =
	| { kind: 'good'; key: string; run: BackupRunView }
	| { kind: 'failed'; key: string; runs: BackupRunView[]; error: string };

export type DownloadProgress = { received: number; total: number };

/** One file in the download window: the run id, the name to save as and the size the page knows before the server answers. */
export type DownloadFile = { id: string; name: string; size: number };

/** The two pieces of the File System Access API this download uses, typed here because the DOM library does not ship them. */
type SaveHandle = {
	createWritable(): Promise<{
		write(chunk: Uint8Array): Promise<void>;
		close(): Promise<void>;
		abort(): Promise<void>;
	}>;
};
type SavePicker = (options: { suggestedName: string }) => Promise<SaveHandle>;
/** A folder the person chose, so several copies are written into it one after another with one click. */
export type SaveFolder = {
	getFileHandle(name: string, options: { create: boolean }): Promise<SaveHandle>;
};
type FolderPicker = (options: { mode: 'readwrite' }) => Promise<SaveFolder>;

// -- CONSTANTS -- //

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const NO_REASON = 'No reason was recorded.';
/** A copy larger than this is never gathered in memory: the browser's own download saves it. */
const MEMORY_LIMIT = 256 * 1024 * 1024;
/** The progress callback runs at most this often, so a fast transfer does not spend its time redrawing. */
const REPORT_MS = 100;

// -- FUNCTIONS -- //

/** A size a person can read: 459 MB, 1.4 GB, 8.2 KB. One decimal under 10, none above. A missing size is a dash. */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '–';
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	if (unit === 0) return `${Math.round(value)} B`;
	// A value that rounds up to 1024 is the next unit, so 1048575 B reads 1.0 MB and not 1024 KB
	if (value >= 1023.5 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** The exact local time of a run, as people say it: Mon 16 Nov 2026, 03:00. */
export function whenText(value: string | Date): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return '';
	const date = d.toLocaleDateString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});
	const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
	return `${date}, ${time}`;
}

/** A shorter time for a line inside a folded row: Sat 14 Nov, 03:40. */
export function whenShort(value: string | Date): string {
	return whenText(value).replace(/ \d{4},/, ',');
}

/** The first six characters of a run id, in mono next to the size, so one copy can be told from another. */
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 6);

/**
 * Turns the runs (newest first) into history rows. Failed runs that follow each other with the same reason fold into one row,
 * so eight identical failures do not bury the good copies. No run is dropped: every one stays inside its row.
 */
export function groupRuns(runs: BackupRunView[]): RunRow[] {
	const rows: RunRow[] = [];
	for (const run of runs) {
		if (run.state !== 'failed') {
			rows.push({ kind: 'good', key: run.id, run });
			continue;
		}
		const error = run.error?.trim() || NO_REASON;
		const last = rows[rows.length - 1];
		if (last?.kind === 'failed' && last.error === error) {
			last.runs.push(run);
			// The group is keyed by its oldest run, which stays the same while newer failures arrive, so an open row stays open
			last.key = run.id;
		} else rows.push({ kind: 'failed', key: run.id, runs: [run], error });
	}
	return rows;
}

/** The newest good copy has its warning in the delete window, because deleting it leaves an older one as the latest. */
export function newestGoodId(runs: BackupRunView[]): string | null {
	return runs.find((r) => r.state === 'done')?.id ?? null;
}

/** The file name the server sends, taken from the response header so the saved file and the window agree. */
function fileNameFrom(header: string | null, fallback: string): string {
	const match = header?.match(/filename="?([^";]+)"?/i);
	return match?.[1] ?? fallback;
}

/** Whether this browser can write several files into one chosen folder. */
export const canPickFolder = () =>
	typeof window !== 'undefined' &&
	typeof (window as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker ===
		'function';

/** Asks for the folder. Must be called straight from the click, before any await that takes time. */
export function pickFolder(): Promise<SaveFolder> {
	return (window as unknown as { showDirectoryPicker: FolderPicker }).showDirectoryPicker({
		mode: 'readwrite'
	});
}

/** Hands the address to the browser's own download, which saves a large file straight to disk with its own progress. */
function startLinkDownload(url: string, name: string) {
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
}

/**
 * Downloads one backup and reports real progress from the response stream against its Content-Length. Where the browser can
 * write straight to a chosen file the bytes never sit in memory; elsewhere they are gathered into a file at the end. A
 * cancelled or failed download saves nothing. `direct` asks for the save window, which needs the person's click to be fresh,
 * so only the first file of a queue uses it.
 */
export async function downloadBackup(
	url: string,
	options: {
		fallbackName: string;
		signal: AbortSignal;
		onProgress: (p: DownloadProgress) => void;
		direct: boolean;
		/** A folder the person chose for a queue of several files: each is written into it, never gathered in memory. */
		folder?: SaveFolder | null;
	}
): Promise<{ name: string; direct: boolean; browser?: boolean }> {
	const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	// The window must open before the first await that takes time, or the browser treats the click as stale
	let target: SaveHandle | null = null;
	if (!options.folder && options.direct && picker)
		target = await picker({ suggestedName: options.fallbackName });
	const res = await fetch(url, { signal: options.signal, credentials: 'same-origin' });
	if (!res.ok || !res.body) {
		// Only a plain sentence from the server is shown; anything else (an error page, JSON) becomes a fixed sentence
		const plain = res.headers.get('content-type')?.startsWith('text/plain')
			? await res.text().catch(() => '')
			: '';
		throw new Error(plain || 'The server could not open the stored copy.');
	}
	// A file in the chosen folder is made only once the server has answered well, so a refusal leaves no empty file behind
	if (options.folder)
		target = await options.folder.getFileHandle(options.fallbackName, { create: true });
	const name = fileNameFrom(res.headers.get('content-disposition'), options.fallbackName);
	const total = Number(res.headers.get('content-length')) || 0;
	const reader = res.body.getReader();
	let received = 0;
	let lastReport = 0;
	const report = (force = false) => {
		const at = performance.now();
		if (!force && at - lastReport < REPORT_MS) return;
		lastReport = at;
		options.onProgress({ received, total });
	};
	report(true);
	// No place to write straight to, and too large to hold: the browser's own download takes over (no byte progress here)
	if (!target && total > MEMORY_LIMIT) {
		await reader.cancel().catch(() => undefined);
		startLinkDownload(url, name);
		received = total;
		report(true);
		return { name, direct: false, browser: true };
	}
	if (target) {
		const out = await target.createWritable();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await out.write(value);
				received += value.byteLength;
				report();
			}
			report(true);
			await out.close();
		} catch (e) {
			await out.abort().catch(() => undefined);
			throw e;
		}
		return { name, direct: true };
	}
	const parts: Uint8Array<ArrayBuffer>[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value as Uint8Array<ArrayBuffer>);
		received += value.byteLength;
		report();
	}
	report(true);
	const href = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }));
	const link = document.createElement('a');
	link.href = href;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(href), 10_000);
	return { name, direct: false };
}
