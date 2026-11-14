// `check rerun-on-change <PATH> --check <KEY>`: LOCAL FILE-WATCH RE-RUNNER FOR DEV CHECKS (STEP A.6, AFB-20261113-1008)
// Kept completely distinct from `check watch` (which polls queued runs from boards). Watches local source files under <PATH>,
// ignores noise (.git, node_modules, build artifacts), debounces bursts, and never overlaps two runs at once.

// IMPORTED DEP-MODULES
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
// IMPORTED MODULES
import { Refusal, UsageError } from './approve.js';

// -- TYPES -- //

export type RerunOptions = {
	watchPath: string;
	checkKey: string;
	item: string;
	org: string;
	registration?: string;
	profile?: string;
	debounceMs?: number;
	signal?: AbortSignal;
	log?: (line: string) => void;
	runCheck: (trigger: { changedFiles: string[]; runNumber: number }) => Promise<number>;
	watchFn?: (
		dir: string,
		listener: (eventType: string, filename: string | Buffer | null) => void
	) => { close(): void };
};

export type RerunSummary = {
	runs: number;
	lastExitCode: number | null;
};

// -- CONSTANTS -- //

const IGNORE_PARTS = new Set(['.git', 'node_modules', '.svelte-kit', 'dist', 'build', '.yarn']);
const DEFAULT_DEBOUNCE_MS = 150;

// -- FUNCTIONS -- //

/** True when a changed relative path belongs to build noise rather than app source. */
export function isIgnoredWatchPath(filename: string | null | undefined): boolean {
	if (!filename) return false;
	const parts = String(filename)
		.split(/[\\/]+/)
		.filter(Boolean);
	return parts.some((p) => IGNORE_PARTS.has(p));
}

/**
 * Watches `watchPath` recursively and invokes `runCheck` whenever files change.
 * Coalesces changes during an active run into at most one trailing re-run. Resolves when `signal` aborts.
 */
export async function rerunOnChange(opts: RerunOptions): Promise<RerunSummary> {
	if (!opts.watchPath || !opts.checkKey || !opts.item || !opts.org) {
		throw new UsageError(
			'Usage: agent-flow-board check rerun-on-change <PATH> --check <KEY> --item <ITEM> --org <slug> [--registration NAME]'
		);
	}
	const target = resolve(opts.watchPath);
	if (!existsSync(target)) {
		throw new Refusal(`Watch path "${opts.watchPath}" does not exist.`);
	}
	const log = opts.log ?? (() => {});
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	let runs = 0;
	let lastExitCode: number | null = null;
	let running = false;
	let pending = false;
	let pendingFiles = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watcher: FSWatcher | { close(): void } | null = null;

	const triggerRun = async () => {
		if (opts.signal?.aborted) return;
		if (running) {
			pending = true;
			return;
		}
		running = true;
		try {
			do {
				pending = false;
				const changedFiles = [...pendingFiles];
				pendingFiles = new Set<string>();
				runs++;
				log(
					`Running ${opts.item} ${opts.checkKey} (#${runs}) after ${changedFiles.length || 1} change(s)...`
				);
				lastExitCode = await opts.runCheck({ changedFiles, runNumber: runs });
			} while (pending && !opts.signal?.aborted);
		} finally {
			running = false;
		}
	};

	const schedule = (file: string) => {
		pendingFiles.add(file);
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void triggerRun();
		}, debounceMs);
	};

	const onEvent = (_event: string, filename: string | Buffer | null) => {
		const name = filename ? String(filename) : '<change>';
		if (isIgnoredWatchPath(name)) return;
		schedule(name);
	};

	watcher = opts.watchFn
		? opts.watchFn(target, onEvent)
		: watch(target, { recursive: true }, onEvent);

	log(`Watching ${target} for changes to re-run ${opts.item} ${opts.checkKey}...`);

	if (opts.signal?.aborted) {
		if (timer) clearTimeout(timer);
		watcher.close();
		return { runs, lastExitCode };
	}

	await new Promise<void>((resolveDone) => {
		const onAbort = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			watcher?.close();
			resolveDone();
		};
		opts.signal?.addEventListener('abort', onAbort, { once: true });
	});

	return { runs, lastExitCode };
}
