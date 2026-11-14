// RENDER QUALITY CHECKS (rules R5 to R9, AFB-20261114-0611): SIDEWAYS OVERFLOW, TAP TARGETS AND AA CONTRAST,
// RUN IN THE BRIDGE'S OWN BROWSER AFTER THE PICTURE AND THE TREE ARE CAPTURED. ADVISORY ONLY: A FINDING IS A
// WARNING AN AGENT MUST ACT ON, NEVER A GATE. EVERY CHECK HAS ITS OWN TRY/CATCH, A NODE COUNT AND A TIME
// BUDGET (ABOUT 1.5 S); A CHECK THAT CANNOT RUN GIVES AN 'unknown' ENTRY AND NEVER LOSES THE RENDER.
// collectQualityFindings is passed to page.evaluate, so it is one self-contained function: every helper and
// constant it needs lives inside it.

// -- TYPES -- //

export type QualityKind = 'overflow' | 'tap' | 'contrast';
export type QualitySeverity = 'fail' | 'unknown';

/** One finding as the page reports it: one per element it saw. */
export type RawQualityFinding = {
	kind: QualityKind;
	severity: QualitySeverity;
	ref?: string;
	selector: string;
	detail: string;
};

/** One finding as it is stored with a render: grouped by kind, selector and severity, with the count in the detail. */
export type QualityCheck = {
	kind: QualityKind;
	severity: QualitySeverity;
	ref?: string;
	selector?: string;
	detail: string;
};

// -- FUNCTIONS (page side) -- //

/**
 * The whole check, inside the page. Returns the findings it saw, the checks that could not run and whether
 * any check stopped at its budget (the bridge turns that into an 'unknown' entry).
 */
export function collectQualityFindings(): {
	findings: RawQualityFinding[];
	couldNotRun: string[];
	truncated: boolean;
} {
	const findings: RawQualityFinding[] = [];
	const couldNotRun: string[] = [];
	let truncated = false;
	// -- CONSTANTS -- //
	const BUDGET_MS = 1_500;
	const FIT_PX = 1;
	const MIN_TAP_PX = 44;
	const MAX_NODES = { overflow: 4_000, tap: 2_000, contrast: 1_500 } as const;
	const MAX_RAW_FINDINGS = 600;

	// -- HELPERS -- //

	/** A short, stable name for one element: its data-ref, its id, or tag with up to two classes. */
	const describeElement = (el: Element): { selector: string; ref?: string } => {
		const ref = el.getAttribute('data-ref') || undefined;
		if (ref) return { selector: `[data-ref="${ref}"]`, ref };
		if (el.id) return { selector: `#${el.id}` };
		let cls = '';
		if (typeof el.className === 'string' && el.className.trim())
			cls = el.className
				.trim()
				.split(/\s+/)
				.slice(0, 2)
				.map((c) => `.${c}`)
				.join('');
		return { selector: `${el.tagName.toLowerCase()}${cls}` };
	};

	const isVisible = (el: Element): boolean => {
		const st = getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return (
			st.display !== 'none' &&
			st.visibility !== 'hidden' &&
			Number(st.opacity || '1') > 0 &&
			rect.width > 0 &&
			rect.height > 0
		);
	};

	// -- OVERFLOW (R6) -- //

	try {
		const vw = window.innerWidth;
		const doc = document.documentElement;
		let seen = 0;
		const deadline = performance.now() + BUDGET_MS;
		if (doc.scrollWidth > Math.ceil(vw))
			findings.push({
				kind: 'overflow',
				severity: 'fail',
				selector: 'document',
				detail: `The page is ${Math.round(doc.scrollWidth)}px wide at a viewport of ${Math.round(vw)}px, so it scrolls sideways.`
			});
		for (const el of document.querySelectorAll('*')) {
			if (findings.length >= MAX_RAW_FINDINGS || seen >= MAX_NODES.overflow) {
				truncated = true;
				break;
			}
			if (performance.now() > deadline) {
				truncated = true;
				break;
			}
			seen++;
			if (!isVisible(el)) continue;
			const rect = el.getBoundingClientRect();
			// The nearest ancestor that clips or scrolls governs: its client box is the element's frame
			let anc: Element | null = el.parentElement;
			let clipper: { el: Element; style: CSSStyleDeclaration; box: DOMRect } | null = null;
			while (anc && anc !== document.body.parentElement) {
				const st = getComputedStyle(anc);
				if (
					['auto', 'scroll', 'hidden', 'clip'].includes(st.overflowX) ||
					['auto', 'scroll', 'hidden', 'clip'].includes(st.overflowY)
				) {
					clipper = { el: anc, style: st, box: anc.getBoundingClientRect() };
					break;
				}
				anc = anc.parentElement;
			}
			if (clipper) {
				// An intentional sideways row (the chip-row rule): it scrolls horizontally and fits the viewport, and
				// its vertical axis is not scrollable (this repo pairs overflow-x-auto with overflow-y-hidden). Chrome
				// collapses the computed values of the two axes, so a scroller whose vertical axis is auto or scroll
				// too is not exempt: a wide child in an overflow-y-auto container is a defect.
				const sc = clipper.style;
				const intentional =
					(sc.overflowX === 'auto' || sc.overflowX === 'scroll') &&
					sc.overflowY !== 'auto' &&
					sc.overflowY !== 'scroll' &&
					clipper.box.right <= vw + FIT_PX &&
					clipper.box.width <= vw + FIT_PX;
				if (!intentional && rect.right > clipper.box.right + FIT_PX) {
					const name = describeElement(el);
					findings.push({
						kind: 'overflow',
						severity: 'fail',
						ref: name.ref,
						selector: name.selector,
						detail: `Runs ${Math.round(rect.right - clipper.box.right)}px past the right edge of its scroll container.`
					});
				}
				continue;
			}
			if (rect.right <= vw + FIT_PX) continue;
			const name = describeElement(el);
			findings.push({
				kind: 'overflow',
				severity: 'fail',
				ref: name.ref,
				selector: name.selector,
				detail: `Runs ${Math.round(rect.right - vw)}px past the right edge of the viewport.`
			});
		}
	} catch (e) {
		couldNotRun.push(`overflow check: ${e instanceof Error ? e.message : String(e)}`);
	}

	// -- TAP TARGETS (R7) -- //

	try {
		const vw = window.innerWidth;
		let seen = 0;
		const deadline = performance.now() + BUDGET_MS;
		for (const el of vw >= 640
			? []
			: document.querySelectorAll(
					'a, button, [role="button"], summary, input, select, textarea, label'
				)) {
			if (findings.length >= MAX_RAW_FINDINGS || seen >= MAX_NODES.tap) {
				truncated = true;
				break;
			}
			if (performance.now() > deadline) {
				truncated = true;
				break;
			}
			seen++;
			if (!isVisible(el)) continue;
			const rect = el.getBoundingClientRect();
			if (rect.width >= MIN_TAP_PX && rect.height >= MIN_TAP_PX) continue;
			// Disabled, inert and pointer-transparent targets are not tap targets
			const st = getComputedStyle(el);
			const inert =
				(el as unknown as { disabled?: boolean }).disabled === true ||
				el.getAttribute('aria-disabled') === 'true' ||
				st.pointerEvents === 'none';
			if (inert) continue;
			// A nested interactive element is skipped: its outer target is the one reported
			let nested = false;
			for (let p = el.parentElement; p; p = p.parentElement) {
				if (p.closest('a, button, [role="button"], summary, input, select, textarea')) {
					nested = true;
					break;
				}
			}
			if (nested) continue;
			const name = describeElement(el);
			findings.push({
				kind: 'tap',
				severity: 'fail',
				ref: name.ref,
				selector: name.selector,
				detail: `${Math.round(rect.width)} by ${Math.round(rect.height)}px is under the ${MIN_TAP_PX} by ${MIN_TAP_PX}px tap target.`
			});
		}
	} catch (e) {
		couldNotRun.push(`tap check: ${e instanceof Error ? e.message : String(e)}`);
	}

	// -- CONTRAST (R8) -- //

	try {
		type RGBA = [number, number, number, number];
		const parseRgb = (s: string): RGBA | null => {
			const v = (s || '').trim();
			if (!v) return null;
			if (v === 'transparent') return [0, 0, 0, 0];
			if (/^(color|oklab|oklch|lab|lch)\(/i.test(v)) return null;
			const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
			if (hex) {
				const h = hex[1]!;
				const n =
					h.length <= 4
						? h
								.split('')
								.map((c) => c + c)
								.join('')
						: h;
				return [
					parseInt(n.slice(0, 2), 16),
					parseInt(n.slice(2, 4), 16),
					parseInt(n.slice(4, 6), 16),
					n.length >= 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1
				];
			}
			const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(
				v
			);
			if (!m) return null;
			let a = 1;
			if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
			return [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, a))];
		};
		// Splits on the commas that are not inside parentheses, so rgba(...) stays whole
		const splitTop = (text: string): string[] => {
			const out: string[] = [];
			let depth = 0;
			let cur = '';
			for (const ch of text) {
				if (ch === '(') depth++;
				if (ch === ')') depth--;
				if (ch === ',' && depth === 0) {
					out.push(cur.trim());
					cur = '';
					continue;
				}
				cur += ch;
			}
			if (cur.trim()) out.push(cur.trim());
			return out;
		};
		const blendOver = (fg: RGBA, bg: [number, number, number]): [number, number, number] => [
			Math.round(fg[0] * fg[3] + bg[0] * (1 - fg[3])),
			Math.round(fg[1] * fg[3] + bg[1] * (1 - fg[3])),
			Math.round(fg[2] * fg[3] + bg[2] * (1 - fg[3]))
		];
		const lum = (r: number, g: number, b: number) => {
			const f = (v: number) => {
				const c = v / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			};
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		};
		const ratioOf = (a: [number, number, number], b: [number, number, number]) => {
			const l1 = lum(a[0], a[1], a[2]);
			const l2 = lum(b[0], b[1], b[2]);
			return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
		};
		// What is painted beneath one element: its background-color and then its ancestors, opacity multiplied
		const underOf = (el: Element): [number, number, number] => {
			const layers: RGBA[] = [];
			let cur: Element | null = el;
			while (cur) {
				const st = getComputedStyle(cur);
				const op = Math.max(0, Math.min(1, Number(st.opacity || '1') || 1));
				const c = parseRgb(st.backgroundColor);
				if (c && c[3] > 0) {
					layers.push([c[0], c[1], c[2], Math.min(1, c[3] * op)]);
					if (c[3] * op >= 0.999) break;
				}
				cur = cur.parentElement;
			}
			let acc: [number, number, number] = [255, 255, 255];
			for (let i = layers.length - 1; i >= 0; i--) acc = blendOver(layers[i]!, acc);
			return acc;
		};
		// The colours one element paints as its background, topmost first; unknown names the layer that cannot be resolved
		const layersOf = (el: Element): { colors: RGBA[]; unknown: string | null } => {
			const st = getComputedStyle(el);
			const webkitFill = (st as unknown as { webkitTextFillColor?: string }).webkitTextFillColor;
			const unknown =
				(st.backgroundClip && st.backgroundClip.split(' ').includes('text')) ||
				(st.mixBlendMode && st.mixBlendMode !== 'normal') ||
				(st.backdropFilter && st.backdropFilter !== 'none')
					? 'a blend or clipped-text effect decides the pixels'
					: webkitFill && webkitFill !== st.color
						? 'a text fill colour effect decides the pixels'
						: null;
			const colors: RGBA[] = [];
			const image = st.backgroundImage;
			if (image && image !== 'none') {
				for (const layer of splitTop(image)) {
					if (/url\(/i.test(layer)) return { colors: [], unknown: 'an image layer paints over it' };
					if (!/(?:linear|radial|conic|repeating)-gradient/i.test(layer)) continue;
					const open = layer.indexOf('(');
					const body = layer.slice(open + 1, layer.lastIndexOf(')'));
					for (const stop of splitTop(body)) {
						// A stop may carry a position after its colour ("rgb(37, 99, 235) 0%"); a direction token is not a stop
						const color =
							parseRgb(stop) ??
							parseRgb(stop.replace(/\s+\S+$/, '')) ??
							(/^\s*(?:to\s|at\s|-?[\d.]+\s*(?:deg|turn|grad|rad)|circle|ellipse)/i.test(stop)
								? undefined
								: null);
						if (color === undefined) continue;
						if (!color)
							return {
								colors: [],
								unknown: 'a gradient stop is a colour the parser cannot read'
							};
						colors.push(color);
					}
				}
			}
			return { colors, unknown };
		};
		const isSrOnly = (el: Element): boolean => {
			if (typeof el.className === 'string' && /\bsr-only\b/.test(el.className)) return true;
			const st = getComputedStyle(el);
			return (
				(st.position === 'absolute' || st.position === 'fixed') &&
				parseInt(st.width || '0', 10) <= 1 &&
				parseInt(st.height || '0', 10) <= 1 &&
				(st.overflow === 'hidden' || st.clip !== 'auto')
			);
		};
		let seen = 0;
		const deadline = performance.now() + BUDGET_MS;
		for (const el of document.querySelectorAll('*')) {
			if (findings.length >= MAX_RAW_FINDINGS || seen >= MAX_NODES.contrast) {
				truncated = true;
				break;
			}
			if (performance.now() > deadline) {
				truncated = true;
				break;
			}
			seen++;
			const directText = Array.from(el.childNodes)
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent || '')
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();
			if (!directText) continue;
			const st = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			const viewport = window.innerWidth;
			// Hidden text: not drawn, fully transparent, clipped away or off the viewport
			if (
				st.display === 'none' ||
				st.visibility === 'hidden' ||
				Number(st.opacity || '1') === 0 ||
				rect.width <= 0 ||
				rect.height <= 0 ||
				rect.bottom < 0 ||
				rect.top > window.innerHeight ||
				rect.right < 0 ||
				rect.left > viewport ||
				isSrOnly(el)
			)
				continue;
			// Disabled and inactive controls are skipped
			if (
				(el as unknown as { disabled?: boolean }).disabled === true ||
				el.getAttribute('aria-disabled') === 'true' ||
				st.pointerEvents === 'none'
			)
				continue;
			const op = Math.max(0, Math.min(1, Number(st.opacity || '1') || 1));
			const fg = parseRgb(st.color);
			if (!fg || fg[3] * op <= 0) continue;
			const name = describeElement(el);
			const under = underOf(el);
			const painted = layersOf(el);
			if (painted.unknown) {
				findings.push({
					kind: 'contrast',
					severity: 'unknown',
					ref: name.ref,
					selector: name.selector,
					detail: `Not checked: ${painted.unknown}.`
				});
				continue;
			}
			// Paint order (R8): the background-color and the ancestors are what every image layer paints over; each
			// gradient stop is checked where it sits (composited over what is beneath it, opacity multiplied), the
			// worst stop decides, and an opaque layer hides whatever is under it
			const fgBlended = blendOver([fg[0], fg[1], fg[2], Math.min(1, fg[3] * op)], under);
			const surfaces: RGBA[] = painted.colors.length
				? painted.colors
				: [[under[0], under[1], under[2], 1]];
			let worst: { ratio: number } | null = null;
			for (const surface of surfaces) {
				const surfaceBlended = blendOver(
					[surface[0], surface[1], surface[2], Math.min(1, surface[3] * op)],
					under
				);
				const ratio = ratioOf(fgBlended, surfaceBlended);
				if (!worst || ratio < worst.ratio) worst = { ratio };
			}
			if (!worst) continue;
			const fontPx = parseFloat(st.fontSize || '16');
			const weight = Number(st.fontWeight || '400');
			const isLarge = fontPx >= 24 || (fontPx >= 18.66 && weight >= 700);
			const required = isLarge ? 3 : 4.5;
			if (worst.ratio >= required) continue;
			findings.push({
				kind: 'contrast',
				severity: 'fail',
				ref: name.ref,
				selector: name.selector,
				detail: `Contrast ${worst.ratio} is below ${required} for ${isLarge ? 'large' : 'normal'} text ("${directText.slice(0, 40)}").`
			});
		}
	} catch (e) {
		couldNotRun.push(`contrast check: ${e instanceof Error ? e.message : String(e)}`);
	}

	return { findings, couldNotRun, truncated };
}

// -- FUNCTIONS (bridge side) -- //

/** Strips control characters before anything is printed or stored. */
export function stripControlChars(text: string): string {
	// Every control character is stripped on purpose: a log or a stored detail never carries one
	return (
		text
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u001F\u007F]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * R9: findings grouped by kind, selector and severity with the count in the detail, ranked fail before
 * unknown, capped at 60 after grouping.
 */
export function groupQualityFindings(raw: RawQualityFinding[]): QualityCheck[] {
	type Group = QualityCheck & { count: number };
	const groups = new Map<string, Group>();
	for (const f of raw) {
		const key = `${f.kind}|${f.severity}|${f.selector}`;
		const found = groups.get(key);
		if (found) {
			found.count++;
			continue;
		}
		groups.set(key, {
			kind: f.kind,
			severity: f.severity,
			ref: f.ref,
			selector: f.selector,
			detail: stripControlChars(f.detail),
			count: 1
		});
	}
	const order: Record<QualityKind, number> = { overflow: 0, tap: 1, contrast: 2 };
	const ranked = [...groups.values()].sort((a, b) => {
		if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
		if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
		return b.count - a.count;
	});
	return ranked.slice(0, 60).map((g) => ({
		kind: g.kind,
		severity: g.severity,
		ref: g.ref,
		selector: g.selector,
		detail: g.count > 1 ? `${g.detail} (${g.count} elements)` : g.detail
	}));
}

/**
 * Re-ranks and caps already grouped checks (the findings of a whole push, rule R9): fail before unknown,
 * at most 60.
 */
export function rankQualityChecks(checks: QualityCheck[]): QualityCheck[] {
	const order: Record<QualityKind, number> = { overflow: 0, tap: 1, contrast: 2 };
	return [...checks]
		.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
			if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
			return (a.selector ?? '').localeCompare(b.selector ?? '');
		})
		.slice(0, 60);
}

/** The one summary line per push: the counts and up to five top groups, unknown counted separately (R9). */
export function summarizeQualityChecks(checks: QualityCheck[]): string {
	if (!checks.length) return '';
	const fails = checks.filter((c) => c.severity === 'fail');
	const unknowns = checks.filter((c) => c.severity === 'unknown');
	const head = `Quality warnings: ${fails.length} fail, ${unknowns.length} could not run (advisory, never gating).`;
	const top = checks.slice(0, 5).map((c) => `${c.kind} ${c.selector ?? ''}: ${c.detail}`);
	return stripControlChars(`${head} Top: ${top.join(' | ')}`);
}

/** The entries a check gives when it could not run at all (R5): the render is still saved. */
export function checkCouldNotRun(kind: QualityKind, message: string): RawQualityFinding {
	return {
		kind,
		severity: 'unknown',
		selector: 'page',
		detail: stripControlChars(`check could not run: ${message}`).slice(0, 300)
	};
}
