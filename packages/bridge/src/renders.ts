// agent-flow-board mockup push ... --renders: WHAT A BROWSER SAW OF EVERY SCREEN, SAVED WITH THE VERSION (AFB-20261114-0409, C.2)
// After a push the page is opened (the signed address on the isolated mockup host, a fresh context with no sign in) at each width,
// one screen after the other, and the picture and the rendered element tree of each are uploaded. The tree comes from the page as
// it is drawn, so markup built by script is in it, which the server's outline cannot see. A render that fails is said, never fatal.

// -- DEP-MODULES -- //
import { createHash, randomBytes } from 'node:crypto';
// -- TYPES -- //
import type { Fetch } from './device.js';
import type { ResolvedMockupTarget } from './checks/mockupTarget.js';
// -- MODULES -- //
import { inspectUrl, redactSignedAddress } from './checks/inspect.js';
import {
	rankQualityChecks,
	summarizeQualityChecks,
	type QualityCheck
} from './checks/qualityChecks.js';
import { resolveMockupTarget } from './checks/mockupTarget.js';
import { call, failure } from './mockup.js';

// -- TYPES -- //

export type RenderOptions = {
	server: string;
	org: string;
	token: string;
	fetch: Fetch;
	mockup: string;
	version: number;
	/** The screens to open. Empty means the page as it opens. */
	screens: string[];
	widths: number[];
	/** Another state to open each screen in, besides the default (a URL hook state=<name>). */
	states?: string[];
	/** Run the advisory quality checks (overflow, tap targets, contrast) at render time (rules R5 to R9). */
	qualityChecks?: boolean;
	log: (line: string) => void;
	wait?: (ms: number) => Promise<unknown>;
	/** For tests: false never retries a capture whose browser died (a fresh context of a shared browser is kept either way). */
	retryOnDeath?: boolean;
	/** For tests and the re-render command: part of the idempotency key, so a second run replaces the first (rule R11). */
	runNonce?: string;
};

export type RenderResult = {
	captured: number;
	failed: { screen: string; width: number; reason: string }[];
	/** The quality findings of the whole run, grouped and ranked (rules R5 to R9). */
	checks?: QualityCheck[];
};

// -- CONSTANTS -- //

export const DEFAULT_RENDER_WIDTHS = [408, 820, 1280, 1600];
const MAX_ELEMENTS = 400;
const REMINT_EVERY = 16;
/** A capture that failed because its browser died (a new lease may fix it), not because the page is broken. */
const BROWSER_DIED =
	/\b(browser|target|context|page)\b.*\b(closed|crashed)\b|\bconnection closed\b|browser.*disconnect|websocket.*clos/i;

// -- FUNCTIONS -- //

/**
 * The screen keys a page declares, lower-cased and capped (rule R3): the afb-config meta tag (pairs or
 * plain strings) plus its data-screen hooks. One grammar with the server's declaredMockupScreenKeys in
 * src/lib/shared/screenGlobs.ts, pinned by the agreement test in renders.test.ts — the bridge is a
 * self-contained published package, so it carries the same function instead of importing the server.
 */
export function screensOfPage(html: string): string[] {
	// The script and style text is stripped first: a CSS attribute selector inside a style block is styling, never a screen
	const source = stripMachineText(html);
	const found: string[] = [];
	const add = (raw: string) => {
		const key = raw.trim().toLowerCase();
		if (!key || !/^[a-z0-9_-]{1,40}$/.test(key)) return;
		if (!found.includes(key)) found.push(key);
	};
	const tag = /<meta\b[^>]*\bname\s*=\s*["']afb-config["'][^>]*>/i.exec(source)?.[0];
	if (tag) {
		const raw = /\bcontent\s*=\s*(?:'([^']*)'|"([^"]*)")/i.exec(tag);
		if (raw) {
			try {
				const parsed = JSON.parse(
					(raw[1] ?? raw[2] ?? '')
						.replace(/&quot;/g, '"')
						.replace(/&#39;|&apos;/gi, "'")
						.replace(/&lt;/gi, '<')
						.replace(/&gt;/gi, '>')
						.replace(/&amp;/gi, '&')
				) as {
					screens?: unknown;
				};
				if (Array.isArray(parsed.screens))
					for (const item of parsed.screens) {
						if (typeof item === 'string') add(item);
						else if (Array.isArray(item) && typeof item[0] === 'string') add(String(item[0]));
					}
			} catch {
				/* A malformed tag falls through to the data-screen scan */
			}
		}
	}
	const attrRx = /\bdata-screen\s*=\s*(?:"([^"]{1,80})"|'([^']{1,80})')/gi;
	let match: RegExpExecArray | null;
	let seen = 0;
	while ((match = attrRx.exec(source)) !== null && seen < 50) {
		seen++;
		add(match[1] ?? match[2] ?? '');
	}
	return found.slice(0, 12);
}

/**
 * The page without its script and style text, the same rule as the server's extractMockupScreensFromHtml:
 * a CSS attribute selector or a script string can never look like a declaration.
 */
function stripMachineText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
}

/** Captures one screen, state and width, retrying once on a new lease when the browser died (rule R4). */
async function captureOne(
	o: RenderOptions,
	minted: ResolvedMockupTarget,
	attempt: {
		screen: string;
		width: number;
		state: string;
	}
) {
	const label = attempt.screen || 'page';
	const open = () =>
		inspectUrl({
			url: minted.url,
			expectedOrigin: minted.origin,
			target: 'mockup',
			screen: attempt.screen || undefined,
			state: attempt.state === 'default' ? undefined : attempt.state,
			width: attempt.width,
			captureScreenshot: true,
			qualityChecks: o.qualityChecks
		});
	try {
		return await open();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (o.retryOnDeath !== false && BROWSER_DIED.test(message)) {
			// The browser of the pool died between captures: once, on a new lease
			o.log(`The browser died during the render of ${label}; trying again on a new browser.`);
			return open();
		}
		throw e;
	}
}

/** Opens every screen at every width, and uploads the picture and the tree of each. */
export async function captureRenders(o: RenderOptions): Promise<RenderResult> {
	const screens = o.screens.length ? o.screens : [''];
	const states = ['default', ...(o.states ?? [])];
	const result: RenderResult = { captured: 0, failed: [] };
	const allChecks: QualityCheck[] = [];
	let checksNoticeSaid = false;
	let minted = await mint(o);
	let sinceMint = 0;
	for (const screen of screens)
		for (const width of o.widths)
			for (const state of states) {
				if (sinceMint >= REMINT_EVERY) {
					minted = await mint(o);
					sinceMint = 0;
				}
				sinceMint++;
				const label = screen || 'page';
				try {
					const shot = await captureOne(o, minted, { screen, width, state });
					const elements = shot.dump.elements.slice(0, MAX_ELEMENTS).map((e) => ({
						...e,
						text: typeof e.text === 'string' ? e.text.slice(0, 120) : e.text
					}));
					const path = `/orgs/${encodeURIComponent(o.org)}/mockups/${o.mockup}/versions/${o.version}/renders`;
					// The server caps an Idempotency-Key at 80 characters and a real mockup id is a 36-character uuid, so
					// the readable form only fits small pages; longer bases are hashed, which is just as stable for a
					// retry in one run and just as unique per run
					const base = `${o.mockup}-${o.version}-${label}-${state}-${width}-${o.runNonce ?? 'push'}`;
					const key =
						base.length <= 66
							? `mockup-render-${base}`
							: `mockup-render-${createHash('sha256').update(base).digest('hex').slice(0, 48)}`;
					const body = JSON.stringify({
						screen: label,
						state,
						width,
						...(shot.screenshot ? { pngBase64: shot.screenshot.toString('base64') } : {}),
						elements,
						...(shot.checks?.length ? { checks: shot.checks } : {})
					});
					let res = await call(o, 'PUT', path, body, { 'content-type': 'application/json' }, key);
					// A rate-limited board waits and retries with the same key and the same body (rule R11)
					for (let tries = 0; res.status === 429 && tries < 3; tries++) {
						const retryAfter = Number(res.headers.get('retry-after'));
						await (o.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(
							Number.isFinite(retryAfter) && retryAfter > 0
								? Math.min(retryAfter * 1000, 30_000)
								: 2_000 * (tries + 1)
						);
						res = await call(o, 'PUT', path, body, { 'content-type': 'application/json' }, key);
					}
					if (!res.ok) throw new Error(await failure(res));
					result.captured++;
					if (shot.checks?.length) {
						allChecks.push(...shot.checks);
						// An older board strips the checks field silently: the reply then carries no checks count (rule R10)
						if (!checksNoticeSaid) {
							const stored = ((await res.json().catch(() => null)) as { checks?: number } | null)
								?.checks;
							if (stored !== shot.checks.length) {
								o.log('This board does not store quality checks.');
								checksNoticeSaid = true;
							}
						}
					}
				} catch (e) {
					// The failure may name the signed address of the page: redact it before the slice and the log (rule R1)
					const reason = redactSignedAddress(e instanceof Error ? e.message : String(e));
					result.failed.push({ screen: label, width, reason: reason.slice(0, 200) });
					o.log(`Render of ${label} at ${width} failed: ${reason.slice(0, 200)}`);
				}
			}
	// One summary line per push: the counts and up to five top groups (rule R9)
	if (o.qualityChecks) {
		result.checks = rankQualityChecks(allChecks);
		const summary = summarizeQualityChecks(result.checks);
		if (summary) o.log(summary);
	}
	return result;
}

async function mint(o: RenderOptions) {
	return resolveMockupTarget({
		server: o.server,
		org: o.org,
		ref: { id: o.mockup, version: o.version, raw: `${o.mockup}@${o.version}` },
		personalToken: o.token,
		fetch: o.fetch,
		log: o.log,
		ttlSeconds: 300
	});
}

/** As long as one part of the page in mockup.ts, so the server's own cap is the real one. */
const HTML_PART_CHARS = 200_000;

export type RenderCommandResult = RenderResult & { version: number };

/**
 * Reads the whole HTML of one version in parts, with the person's own token: no file is written and no
 * session is recorded (rule R3). The screens of the render come from this source.
 */
export async function readMockupVersionHtml(o: {
	server: string;
	org: string;
	token: string;
	fetch: Fetch;
	mockup: string;
	version?: number;
	log: (line: string) => void;
	wait?: (ms: number) => Promise<unknown>;
}): Promise<{ html: string; version: number }> {
	const base = `/orgs/${encodeURIComponent(o.org)}/mockups/${encodeURIComponent(o.mockup)}/html`;
	const parts: string[] = [];
	let offset = 0;
	let first: { version: number; length: number } | null = null;
	const id = randomBytes(8).toString('hex');
	for (let n = 0; n < 2000; n++) {
		const q = new URLSearchParams({ offset: String(offset), limit: String(HTML_PART_CHARS) });
		const pinned = o.version ?? first?.version;
		if (pinned) q.set('version', String(pinned));
		const res = await call(o, 'GET', `${base}?${q}`, undefined, {}, `mockup-html-${id}-${offset}`);
		if (!res.ok) throw new Error(await failure(res));
		const part = (await res.json()) as {
			html: string;
			version: number;
			length: number;
			more: boolean;
		};
		first ??= { version: part.version, length: part.length };
		if (part.version !== first.version || part.length !== first.length)
			throw new Error('The mockup changed while its screens were read. Run the command again.');
		parts.push(part.html);
		offset += part.html.length;
		if (!part.more || part.html.length === 0) break;
	}
	if (first === null) throw new Error('The board sent no page. Run the command again.');
	return { html: parts.join(''), version: first.version };
}

/**
 * agent-flow-board mockup renders <mockup id> [--version n] [--widths ...] [--render-states ...] (rules R3
 * and R11): re-renders an existing version with the person's own token, no file written. The screens come
 * from the version's own HTML; the server refuses an undeclared screen. Exits 0 when every render was
 * saved, and the caller reports 1 with the failed list otherwise (the rest still render).
 */
export async function renderVersionCommand(
	o: Omit<RenderOptions, 'version' | 'screens'> & { version?: number }
): Promise<RenderCommandResult> {
	const read = await readMockupVersionHtml(o);
	const screens = screensOfPage(read.html);
	o.log(
		`Rendering version ${read.version}: ${screens.length ? screens.join(', ') : 'the page as it opens'}.`
	);
	const result = await captureRenders({
		...o,
		version: read.version,
		screens,
		qualityChecks: o.qualityChecks ?? true
	});
	return { ...result, version: read.version };
}
