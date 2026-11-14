// SHARED SCREEN-GLOB MATCHING AND VISIBLE-STEP HELPERS (C.1, AFB-20261113-1008)
// Linear-time bounded glob matching and screen extraction shared across server ops, validation, and UI.

// -- CONSTANTS -- //

export const DEFAULT_SCREEN_GLOBS = [
	'**/*.svelte',
	'**/*.tsx',
	'**/*.vue',
	'**/*.css',
	'**/routes/**',
	'**/components/**'
] as const;

const MAX_GLOB_LEN = 200;
const MAX_PATH_LEN = 500;
const UI_SCREEN_HINT = /\b(?:screen(?!\s*globs?\b)|page|dialog|modal|drawer|sidebar)\b/i;

// -- TYPES -- //

export type NamedMockupScreen = { key: string; label: string };

// -- FUNCTIONS -- //

/** Normalises a repository-relative path to forward slashes without leading "./" or "/". */
export function normaliseGlobPath(filePath: string): string {
	return filePath
		.trim()
		.replace(/\\/g, '/')
		.replace(/^(?:\.\/|\/)+/, '')
		.slice(0, MAX_PATH_LEN);
}

/**
 * Compiles one glob pattern (`**`, `*`, `?`) without overlapping wildcards so matching runs in bounded linear time.
 * Patterns longer than MAX_GLOB_LEN or empty return null.
 */
function compileGlob(rawPattern: string): RegExp | null {
	const pattern = normaliseGlobPath(rawPattern);
	if (!pattern || rawPattern.trim().length > MAX_GLOB_LEN) return null;
	let out = '^';
	let i = 0;
	while (i < pattern.length) {
		if (pattern.startsWith('**/', i)) {
			// Skip duplicate "**/" prefixes to prevent nested backtracking
			while (pattern.startsWith('**/', i)) i += 3;
			out += '(?:[^/]+/)*';
			continue;
		}
		if (pattern.startsWith('**', i)) {
			while (pattern[i] === '*') i++;
			out += '.*';
			continue;
		}
		const ch = pattern[i];
		if (ch === '*') {
			while (pattern[i] === '*') i++;
			out += '[^/]*';
		} else if (ch === '?') {
			out += '[^/]';
			i++;
		} else {
			out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			i++;
		}
	}
	out += '$';
	return new RegExp(out, 'i');
}

/** True when a file path matches one glob pattern (for example svelte or route paths). */
export function matchesScreenGlob(filePath: string, pattern: string): boolean {
	const norm = normaliseGlobPath(filePath);
	if (!norm) return false;
	const rx = compileGlob(pattern);
	return rx ? rx.test(norm) : false;
}

/** True when any file in the list matches at least one project screen glob. */
export function anyFileMatchesScreenGlobs(
	files: readonly string[],
	globs: readonly string[]
): boolean {
	if (!files.length || !globs.length) return false;
	const compiled = globs.map(compileGlob).filter((r): r is RegExp => r !== null);
	if (!compiled.length) return false;
	for (const f of files) {
		const norm = normaliseGlobPath(f);
		if (!norm) continue;
		if (compiled.some((rx) => rx.test(norm))) return true;
	}
	return false;
}

/** Effective visible state of a step: explicit author mark (`true`/`false`), else `visibleInferred`. */
export function effectiveStepVisible(s: {
	visible?: boolean | null;
	visibleInferred?: boolean;
}): boolean {
	return s.visible !== null && s.visible !== undefined ? s.visible : Boolean(s.visibleInferred);
}

/** Extracts declared screen keys and labels from `<meta name="afb-config">` and `data-screen` hooks in mockup HTML. */
export function extractMockupScreensFromHtml(html: string): NamedMockupScreen[] {
	// The script and style text is stripped first: a CSS attribute selector inside a style block is styling, never a screen
	const source = stripMachineText(html);
	const found = new Map<string, NamedMockupScreen>();
	const add = (key: string, label?: string) => {
		const cleanKey = key.trim();
		if (!cleanKey) return;
		const cleanLabel = (label ?? cleanKey).trim() || cleanKey;
		if (!found.has(cleanKey.toLowerCase())) {
			found.set(cleanKey.toLowerCase(), { key: cleanKey, label: cleanLabel });
		}
	};

	const at = source.indexOf('afb-config');
	if (at !== -1) {
		const start = Math.max(source.lastIndexOf('<meta', at), source.lastIndexOf('<META', at));
		if (start !== -1 && at - start <= 200) {
			const slice = source.slice(start, start + 10_000);
			const m = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(slice);
			if (m) {
				try {
					const raw = (m[1] ?? m[2] ?? '')
						.replace(/&quot;/gi, '"')
						.replace(/&#39;|&apos;/gi, "'")
						.replace(/&lt;/gi, '<')
						.replace(/&gt;/gi, '>')
						.replace(/&amp;/gi, '&');
					const parsed = JSON.parse(raw) as { screens?: unknown };
					if (Array.isArray(parsed?.screens)) {
						for (const item of parsed.screens) {
							if (typeof item === 'string') {
								add(item, item);
							} else if (Array.isArray(item) && typeof item[0] === 'string') {
								add(item[0], typeof item[1] === 'string' ? item[1] : item[0]);
							}
						}
					}
				} catch {
					// Malformed afb-config falls back to data-screen scan below
				}
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

	return [...found.values()];
}

/** At most this many declared screens are ever compared or rendered. */
export const MAX_DECLARED_MOCKUP_SCREENS = 12;

/**
 * The declared screen keys of one page, lower-cased, unique and capped (rule R3, AFB-20261114-0611):
 * the afb-config keys (pairs or plain strings) plus its data-screen hooks. The server compares a
 * render's screen against this set and the bridge renders exactly these keys; page is allowed when
 * the set is empty. One grammar, pinned by the agreement test in the bridge.
 */
export function declaredMockupScreenKeys(html: string): string[] {
	return extractMockupScreensFromHtml(html)
		.map((s) => s.key.trim().toLowerCase())
		.filter((k) => /^[a-z0-9_-]{1,40}$/.test(k))
		.filter((k, i, all) => all.indexOf(k) === i)
		.slice(0, MAX_DECLARED_MOCKUP_SCREENS);
}

/**
 * The page without its script and style text, so a CSS attribute selector or a script string can never
 * look like a declaration (a `[data-screen="x"]` rule inside a style block is styling, not a screen).
 */
function stripMachineText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when step wording mentions a declared mockup screen, a screen file path, or a screen/page/dialog noun. */
export function stepTextNamesScreen(
	text: string,
	mockupScreens: readonly NamedMockupScreen[],
	globs: readonly string[]
): boolean {
	if (!text.trim()) return false;
	for (const scr of mockupScreens) {
		for (const candidate of [scr.key, scr.label]) {
			const clean = candidate.trim();
			if (clean.length < 2 || clean.length > 80) continue;
			const rx = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(clean)}(?![A-Za-z0-9_])`, 'i');
			if (rx.test(text)) return true;
		}
	}
	if (UI_SCREEN_HINT.test(text)) return true;
	const tokens = text
		.split(/[\s`'",()[\]{}<>]+/)
		.filter((t) => t.length >= 3 && (t.includes('/') || t.includes('.')));
	return anyFileMatchesScreenGlobs(tokens, globs);
}
