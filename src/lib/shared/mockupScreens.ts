// SHARED MOCKUP SCREEN EXTRACTION
// Reads the screens a mockup page declares, shared across the server, the bridge and the UI.

// -- TYPES -- //

export type NamedMockupScreen = { key: string; label: string };

// -- FUNCTIONS -- //

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
