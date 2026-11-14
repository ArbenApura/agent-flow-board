// HMR-AWARE READINESS FOR DEV-SERVER CHECKS (STEP A.3, AFB-20261113-1008)
// Waits until Vite HMR is connected and idle with no pending updates or in-flight network requests,
// and falls back to load + settle window on non-Vite dev servers. Fails loudly with redacted overlay detail + fixed fix line on dev error overlay.

// IMPORTED MODULES
import { redact } from './redact.js';

// -- TYPES -- //

export type DevReadinessMode = 'vite' | 'fallback';

export type DevReadinessCode =
	'DEV_HMR_DISCONNECTED' | 'DEV_HMR_PENDING' | 'DEV_OVERLAY_ERROR' | 'DEV_NETWORK_BUSY';

export class DevReadinessError extends Error {
	readonly code: DevReadinessCode;
	readonly fixLine: string;
	readonly detail?: string;

	constructor(code: DevReadinessCode, message: string, fixLine: string, detail?: string) {
		super(`${code}: ${message} Fix: ${fixLine}${detail ? `\n${detail}` : ''}`);
		this.name = 'DevReadinessError';
		this.code = code;
		this.fixLine = fixLine;
		this.detail = detail;
	}
}

export interface DevReadyContextLike {
	addInitScript(script: string): Promise<void>;
}

export interface DevReadyPageLike {
	waitForLoadState(
		state?: 'load' | 'domcontentloaded' | 'networkidle',
		opts?: { timeout?: number }
	): Promise<void>;
	evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
}

export type DevReadinessSnapshot = {
	viteDetected: boolean;
	hmrConnected: boolean;
	pendingUpdates: number;
	inFlightNetwork: number;
	overlayText: string | null;
};

export type DevReadinessResult = {
	mode: DevReadinessMode;
	waitedMs: number;
};

export type DevReadinessOptions = {
	timeoutMs?: number;
	settleMs?: number;
	pollMs?: number;
	redactionNeedles?: readonly string[];
};

// -- CONSTANTS -- //

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_VITE_SETTLE_MS = 80;
const DEFAULT_FALLBACK_SETTLE_MS = 250;
const DEFAULT_POLL_MS = 40;
const OVERLAY_SNIPPET_MAX = 400;

export const DEV_READINESS_FIX_LINES: Record<DevReadinessCode, string> = {
	DEV_OVERLAY_ERROR:
		'Fix the compiler or runtime error shown by the dev server overlay and re-run.',
	DEV_HMR_DISCONNECTED: 'Ensure the Vite dev server is running and reload the page.',
	DEV_HMR_PENDING: 'Wait for active Vite HMR updates to settle or fix the failing module update.',
	DEV_NETWORK_BUSY: 'Check for hanging API requests or continuous polling on the screen.'
};

/**
 * Injected once per browser context to passively observe Vite HMR WebSocket state (`vite-hmr` subprotocol),
 * pending HMR updates, and in-flight same-origin fetch requests without modifying page behaviour.
 */
export const DEV_READINESS_INIT_SCRIPT = `(() => {
	if (window.__afbDevReadyInstalled) return;
	window.__afbDevReadyInstalled = true;
	const state = (window.__afbDevReady = {
		viteDetected: false,
		hmrConnected: false,
		pendingUpdates: 0,
		inFlightNetwork: 0,
		overlayError: null,
		lastUpdateAt: 0
	});
	const OrigWS = window.WebSocket;
	if (typeof OrigWS === 'function') {
		window.WebSocket = function AfbTrackedWebSocket(url, protocols) {
			const ws = arguments.length > 1 ? new OrigWS(url, protocols) : new OrigWS(url);
			const protoList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
			const urlText = String(url ?? '');
			const isVite = protoList.includes('vite-hmr') || urlText.includes('__vite') || urlText.includes('vite-hmr');
			if (isVite) {
				state.viteDetected = true;
				ws.addEventListener('open', () => {
					state.hmrConnected = true;
				});
				ws.addEventListener('close', () => {
					state.hmrConnected = false;
				});
				ws.addEventListener('error', () => {
					state.hmrConnected = false;
				});
				ws.addEventListener('message', (ev) => {
					try {
						const msg = JSON.parse(String(ev.data ?? ''));
						if (!msg || typeof msg !== 'object') return;
						if (msg.type === 'connected') {
							state.hmrConnected = true;
							state.overlayError = null;
						} else if (msg.type === 'update') {
							state.viteDetected = true;
							state.pendingUpdates++;
							state.lastUpdateAt = Date.now();
							setTimeout(() => {
								state.pendingUpdates = Math.max(0, state.pendingUpdates - 1);
							}, 60);
						} else if (msg.type === 'full-reload') {
							state.viteDetected = true;
							state.overlayError = null;
						} else if (msg.type === 'error' && msg.err) {
							state.overlayError = String(msg.err.message || 'Vite dev server error');
						}
					} catch {
						// Ignore non-JSON frames
					}
				});
			}
			return ws;
		};
		window.WebSocket.prototype = OrigWS.prototype;
		Object.assign(window.WebSocket, OrigWS);
	}
	const origFetch = window.fetch;
	if (typeof origFetch === 'function') {
		window.fetch = function afbTrackedFetch(input, init) {
			const urlText = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : '';
			const ping = urlText.includes('__vite_ping');
			if (!ping) state.inFlightNetwork++;
			return origFetch.apply(this, arguments).finally(() => {
				if (!ping) state.inFlightNetwork = Math.max(0, state.inFlightNetwork - 1);
			});
		};
	}
})();`;

// -- FUNCTIONS -- //

/** Installs the passive HMR and network observer on a Playwright BrowserContext. */
export async function installDevReadinessHook(ctx: DevReadyContextLike): Promise<void> {
	await ctx.addInitScript(DEV_READINESS_INIT_SCRIPT);
}

/** Evaluates DOM + WebSocket HMR state inside the target page. Exported for testing. */
export function readSnapshotInPage(): DevReadinessSnapshot {
	const w = window as unknown as {
		__afbDevReady?: {
			viteDetected: boolean;
			hmrConnected: boolean;
			pendingUpdates: number;
			inFlightNetwork: number;
			overlayError: string | null;
		};
	};
	const tracked = w.__afbDevReady;
	const overlayEl = document.querySelector('vite-error-overlay') as
		(Element & { shadowRoot?: ShadowRoot | null }) | null;
	const overlayDomText = overlayEl
		? (overlayEl.shadowRoot?.textContent ?? overlayEl.textContent ?? '').trim()
		: '';
	const overlayText = overlayDomText || tracked?.overlayError || null;
	const hasViteScript = Boolean(
		document.querySelector('script[src*="/@vite/client"]') ||
		(typeof performance !== 'undefined' &&
			performance.getEntriesByType('resource').some((r) => r.name.includes('/@vite/client')))
	);
	return {
		viteDetected: Boolean(tracked?.viteDetected || hasViteScript),
		hmrConnected: Boolean(tracked?.hmrConnected),
		pendingUpdates: tracked?.pendingUpdates ?? 0,
		inFlightNetwork: tracked?.inFlightNetwork ?? 0,
		overlayText
	};
}

function overlayFailure(rawText: string, needles: readonly string[]): DevReadinessError {
	const cleaned = redact(rawText.replace(/\s+/g, ' ').trim(), needles).slice(
		0,
		OVERLAY_SNIPPET_MAX
	);
	return new DevReadinessError(
		'DEV_OVERLAY_ERROR',
		'The dev server rendered an error overlay.',
		DEV_READINESS_FIX_LINES.DEV_OVERLAY_ERROR,
		cleaned
	);
}

/**
 * Waits until the dev-server page is ready for a screenshot or layout measurement:
 * - On Vite: HMR WebSocket connected, zero pending updates, network idle, no error overlay.
 * - On non-Vite servers: DOM load + settle window + bounded network idle, no error overlay.
 */
export async function waitForDevReady(
	page: DevReadyPageLike,
	opts: DevReadinessOptions = {}
): Promise<DevReadinessResult> {
	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
	const needles = opts.redactionNeedles ?? [];
	const deadline = startedAt + timeoutMs;

	await page.waitForLoadState('load', { timeout: timeoutMs });

	const first = await page.evaluate(readSnapshotInPage);
	if (first.overlayText) {
		throw overlayFailure(first.overlayText, needles);
	}

	if (!first.viteDetected) {
		const settleMs = opts.settleMs ?? DEFAULT_FALLBACK_SETTLE_MS;
		const remaining = Math.max(200, deadline - Date.now());
		await page
			.waitForLoadState('networkidle', { timeout: Math.min(2_000, remaining) })
			.catch(() => {});
		if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
		const after = await page.evaluate(readSnapshotInPage);
		if (after.overlayText) throw overlayFailure(after.overlayText, needles);
		if (after.viteDetected) {
			// Dynamically loaded @vite/client right after initial load: fall through to Vite checks below
		} else {
			return { mode: 'fallback', waitedMs: Date.now() - startedAt };
		}
	}

	const viteSettleMs = opts.settleMs ?? DEFAULT_VITE_SETTLE_MS;
	let lastSnap: DevReadinessSnapshot = first;
	let idleSince: number | null = null;

	while (Date.now() < deadline) {
		lastSnap = await page.evaluate(readSnapshotInPage);
		if (lastSnap.overlayText) {
			throw overlayFailure(lastSnap.overlayText, needles);
		}
		const idleNow =
			lastSnap.hmrConnected && lastSnap.pendingUpdates === 0 && lastSnap.inFlightNetwork === 0;
		if (idleNow) {
			if (idleSince === null) idleSince = Date.now();
			if (Date.now() - idleSince >= viteSettleMs) {
				const rem = Math.max(100, deadline - Date.now());
				await page
					.waitForLoadState('networkidle', { timeout: Math.min(1_000, rem) })
					.catch(() => {});
				const finalSnap = await page.evaluate(readSnapshotInPage);
				if (finalSnap.overlayText) throw overlayFailure(finalSnap.overlayText, needles);
				if (
					finalSnap.hmrConnected &&
					finalSnap.pendingUpdates === 0 &&
					finalSnap.inFlightNetwork === 0
				) {
					return { mode: 'vite', waitedMs: Date.now() - startedAt };
				}
				idleSince = null;
			}
		} else {
			idleSince = null;
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}

	if (lastSnap.overlayText) throw overlayFailure(lastSnap.overlayText, needles);
	if (!lastSnap.hmrConnected) {
		throw new DevReadinessError(
			'DEV_HMR_DISCONNECTED',
			'Vite HMR WebSocket did not connect before timeout.',
			DEV_READINESS_FIX_LINES.DEV_HMR_DISCONNECTED
		);
	}
	if (lastSnap.pendingUpdates > 0) {
		throw new DevReadinessError(
			'DEV_HMR_PENDING',
			'Vite HMR still had pending module updates at timeout.',
			DEV_READINESS_FIX_LINES.DEV_HMR_PENDING
		);
	}
	throw new DevReadinessError(
		'DEV_NETWORK_BUSY',
		'In-flight network requests did not settle before timeout.',
		DEV_READINESS_FIX_LINES.DEV_NETWORK_BUSY
	);
}
