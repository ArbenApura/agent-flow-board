// EARLY STOCK CHECKS ON DEV SWEEPS (STEP A.10, AFB-20261113-1008)
// Runs on every screen the dev loop photographs (no mockup needed): layout shift (CLS) and tap targets under 44 px.
// -- CONSTANTS -- //
export const DEFAULT_MAX_CLS = 0.1;
export const DEFAULT_MIN_TAP_PX = 44;
export const EARLY_CLS_INIT_SCRIPT = `(() => {
	if (window.__afbClsInstalled) return;
	window.__afbClsInstalled = true;
	const cls = (window.__afbCls = { score: 0, shifts: 0 });
	if (typeof PerformanceObserver !== 'function') return;
	try {
		const obs = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!entry.hadRecentInput && typeof entry.value === 'number') {
					cls.score += entry.value;
					cls.shifts += 1;
				}
			}
		});
		obs.observe({ type: 'layout-shift', buffered: true });
	} catch {
		// Ignore unsupported entry types
	}
})();`;
// -- FUNCTIONS -- //
/** Resets accumulated layout-shift metrics inside the page before measuring another view. */
export async function resetEarlyCls(page) {
    await page.evaluate(() => {
        const w = window;
        if (w.__afbCls) {
            w.__afbCls.score = 0;
            w.__afbCls.shifts = 0;
        }
    }, undefined);
}
/** Measures CLS and sub-44px interactive tap targets in one page evaluation. */
export async function measureEarlyStockChecks(page, opts = {}) {
    const maxCls = opts.maxCls ?? DEFAULT_MAX_CLS;
    const minTapPx = opts.minTapPx ?? DEFAULT_MIN_TAP_PX;
    const raw = await page.evaluate((threshold) => {
        const w = window;
        const score = Number((w.__afbCls?.score ?? 0).toFixed(4));
        const shifts = w.__afbCls?.shifts ?? 0;
        const selectors = [
            'button',
            'input:not([type="hidden"])',
            'select',
            'textarea',
            '[role="button"]',
            '[role="tab"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[role="switch"]',
            'a[href]'
        ].join(',');
        const violations = [];
        let total = 0;
        const viewportWidth = window.innerWidth;
        for (const el of document.querySelectorAll(selectors)) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden')
                continue;
            // Inline text links inside running prose sentences follow line height, not 44px button sizing
            if (el.tagName === 'A' && style.display === 'inline' && !el.getAttribute('role'))
                continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0)
                continue;
            total++;
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);
            if (width < threshold || height < threshold) {
                const text = (el.textContent || el.getAttribute('aria-label') || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 40);
                violations.push({
                    tag: el.tagName.toLowerCase(),
                    text,
                    width,
                    height,
                    viewportWidth
                });
            }
        }
        return { score, shifts, total, violations };
    }, minTapPx);
    const clsPassed = raw.score <= maxCls;
    const tapPassed = raw.violations.length === 0;
    return {
        schema: 1,
        cls: { score: raw.score, shifts: raw.shifts, maxCls, passed: clsPassed },
        tapTargets: {
            total: raw.total,
            smallCount: raw.violations.length,
            minTapPx,
            violations: raw.violations.slice(0, 25),
            passed: tapPassed
        },
        passed: clsPassed && tapPassed
    };
}
