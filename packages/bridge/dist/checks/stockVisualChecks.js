// VERSIONED STOCK VISUAL CHECKS (STEP E.1, AFB-20261113-1008)
// Parameterised visual quality checks runnable on any page in a browser check or compare harness.
// Covers CLS per screen/state, tap targets < 44px, sideways scroll, default browser button chrome,
// contrast pairs (WCAG), skeleton vs loaded height, focus visible, reduced motion, and console errors.
// -- MODULES -- //
import { DEFAULT_MAX_CLS, DEFAULT_MIN_TAP_PX, EARLY_CLS_INIT_SCRIPT, measureEarlyStockChecks, resetEarlyCls } from './earlyStockChecks.js';
// -- CONSTANTS -- //
export const STOCK_VISUAL_CHECKS_VERSION = 1;
export const DEFAULT_MIN_CONTRAST_NORMAL = 4.5;
export const DEFAULT_MIN_CONTRAST_LARGE = 3;
export const DEFAULT_MAX_SKELETON_DELTA = 0.25;
// -- FUNCTIONS -- //
/** Parses `#rgb`, `#rrggbb`, `rgb(r,g,b)`, and `rgba(r,g,b,a)` strings for unit testing and contrast checks. */
export function parseCssColor(raw) {
    const s = raw.trim().toLowerCase();
    if (!s || s === 'transparent')
        return [0, 0, 0, 0];
    const rgbMatch = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
    if (rgbMatch) {
        const r = Math.min(255, Math.max(0, Number(rgbMatch[1])));
        const g = Math.min(255, Math.max(0, Number(rgbMatch[2])));
        const b = Math.min(255, Math.max(0, Number(rgbMatch[3])));
        const aRaw = rgbMatch[4];
        let a = 1;
        if (aRaw !== undefined) {
            a = aRaw.endsWith('%') ? Number(aRaw.slice(0, -1)) / 100 : Number(aRaw);
        }
        return [r, g, b, Math.min(1, Math.max(0, a))];
    }
    const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
    if (hexMatch) {
        const hex = hexMatch[1];
        const full = hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
        return [
            parseInt(full.slice(0, 2), 16),
            parseInt(full.slice(2, 4), 16),
            parseInt(full.slice(4, 6), 16),
            1
        ];
    }
    return null;
}
/** WCAG 2.1 relative luminance for 8-bit sRGB channels. */
export function relativeLuminance(r, g, b) {
    const channel = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** WCAG 2.1 contrast ratio between two opaque RGB colors (1..21). */
export function wcagContrastRatio(fg, bg) {
    const l1 = relativeLuminance(fg[0], fg[1], fg[2]);
    const l2 = relativeLuminance(bg[0], bg[1], bg[2]);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}
/** Evaluates skeleton vs loaded height drift symmetrically. */
export function evaluateSkeletonHeight(skeletonHeightPx, loadedHeightPx, maxDelta = DEFAULT_MAX_SKELETON_DELTA) {
    if (skeletonHeightPx == null ||
        skeletonHeightPx <= 0 ||
        loadedHeightPx == null ||
        loadedHeightPx <= 0) {
        return {
            kind: 'skeleton-height',
            passed: true,
            summary: 'No loading skeleton baseline recorded.',
            measured: {
                skeletonHeightPx: skeletonHeightPx ?? null,
                loadedHeightPx: loadedHeightPx ?? null,
                ratioDelta: null,
                maxDelta
            }
        };
    }
    const diff = Math.abs(loadedHeightPx - skeletonHeightPx);
    const base = Math.max(loadedHeightPx, skeletonHeightPx);
    const ratioDelta = Math.round((diff / base) * 1000) / 1000;
    const passed = ratioDelta <= maxDelta;
    return {
        kind: 'skeleton-height',
        passed,
        summary: passed
            ? `Skeleton height ${skeletonHeightPx}px matches loaded ${loadedHeightPx}px (delta ${ratioDelta} <= ${maxDelta}).`
            : `Skeleton height ${skeletonHeightPx}px shifted to ${loadedHeightPx}px (delta ${ratioDelta} > ${maxDelta}).`,
        measured: {
            skeletonHeightPx,
            loadedHeightPx,
            ratioDelta,
            maxDelta
        }
    };
}
/** Attaches page error and console error collectors onto a Playwright-like page object. */
export function attachConsoleErrorCollector(page) {
    const errors = [];
    if (typeof page.on !== 'function')
        return errors;
    page.on('pageerror', (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
    });
    page.on('console', (msg) => {
        const m = msg;
        if (m && typeof m.type === 'function' && m.type() === 'error') {
            errors.push(typeof m.text === 'function' ? m.text() : String(msg));
        }
    });
    return errors;
}
/** Filters console errors against ignore patterns so expected test warnings can be excluded explicitly. */
export function filterConsoleErrors(errors, ignorePatterns = []) {
    if (!ignorePatterns.length)
        return [...errors];
    return errors.filter((entry) => !ignorePatterns.some((pat) => typeof pat === 'string' ? entry.includes(pat) : pat.test(entry)));
}
/** Runs all 9 versioned parameterised stock visual checks on a rendered page. */
export async function runStockVisualChecks(page, opts = {}) {
    const screen = opts.screen ?? 'default';
    const state = opts.state ?? 'default';
    const maxCls = opts.maxCls ?? DEFAULT_MAX_CLS;
    const minTapPx = opts.minTapPx ?? DEFAULT_MIN_TAP_PX;
    const minContrastNormal = opts.minContrastNormal ?? DEFAULT_MIN_CONTRAST_NORMAL;
    const minContrastLarge = opts.minContrastLarge ?? DEFAULT_MIN_CONTRAST_LARGE;
    const maxSkeletonDelta = opts.maxSkeletonHeightDelta ?? DEFAULT_MAX_SKELETON_DELTA;
    const early = await measureEarlyStockChecks(page, { maxCls, minTapPx });
    const domProbe = await page.evaluate(({ minContrastNormal: minNormal, minContrastLarge: minLarge, allowDefaultChrome }) => {
        const parseRgb = (raw) => {
            const s = raw.trim().toLowerCase();
            if (s === 'transparent')
                return [0, 0, 0, 0];
            const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s);
            if (!m)
                return null;
            let alpha = 1;
            if (m[4] !== undefined) {
                alpha = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4]);
            }
            return [
                Number(m[1]),
                Number(m[2]),
                Number(m[3]),
                Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))
            ];
        };
        const blendOver = (fg, bg) => {
            const a = fg[3];
            return [
                Math.round(fg[0] * a + bg[0] * (1 - a)),
                Math.round(fg[1] * a + bg[1] * (1 - a)),
                Math.round(fg[2] * a + bg[2] * (1 - a))
            ];
        };
        const lum = (r, g, b) => {
            const f = (v) => {
                const c = v / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (fg, bg) => {
            const l1 = lum(fg[0], fg[1], fg[2]);
            const l2 = lum(bg[0], bg[1], bg[2]);
            return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
        };
        const effectiveBg = (el) => {
            const layers = [];
            let cur = el;
            while (cur) {
                const st = getComputedStyle(cur);
                const c = parseRgb(st.backgroundColor);
                const elemOpacity = Math.max(0, Math.min(1, Number(st.opacity || '1') || 1));
                if (c && c[3] > 0) {
                    layers.push([c[0], c[1], c[2], Math.min(1, c[3] * elemOpacity)]);
                    if (c[3] * elemOpacity >= 0.999)
                        break;
                }
                cur = cur.parentElement;
            }
            let acc = [255, 255, 255];
            for (let i = layers.length - 1; i >= 0; i--) {
                acc = blendOver(layers[i], acc);
            }
            return acc;
        };
        // 1. Default browser button chrome check
        const buttonChromeViolations = [];
        if (!allowDefaultChrome) {
            for (const btn of Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))) {
                const style = getComputedStyle(btn);
                const rect = btn.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden')
                    continue;
                const app = style.appearance ||
                    style.webkitAppearance ||
                    '';
                const bg = style.backgroundColor;
                const radius = parseFloat(style.borderRadius || '0');
                if ((app === 'button' || app === 'auto') &&
                    radius === 0 &&
                    (bg === 'rgb(239, 239, 239)' || bg === 'buttonface')) {
                    buttonChromeViolations.push({
                        tag: btn.tagName.toLowerCase(),
                        text: (btn.textContent || '').trim().slice(0, 40),
                        appearance: app,
                        background: bg
                    });
                }
            }
        }
        // 2. WCAG contrast check across visible text elements (checks elements with direct text nodes so icon+label buttons count)
        const contrastViolations = [];
        for (const node of Array.from(document.querySelectorAll('p, span, a, button, label, h1, h2, h3, h4, td, th, li'))) {
            if (contrastViolations.length >= 25)
                break;
            const directText = Array.from(node.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent || '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!directText)
                continue;
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0)
                continue;
            const style = getComputedStyle(node);
            const opacity = Number(style.opacity || '1');
            if (style.visibility === 'hidden' || opacity === 0)
                continue;
            const fg = parseRgb(style.color);
            if (!fg || fg[3] < 0.05)
                continue;
            const bg = effectiveBg(node);
            const fgAlpha = Math.min(1, fg[3] * opacity);
            const fgBlended = blendOver([fg[0], fg[1], fg[2], fgAlpha], bg);
            const ratio = contrast(fgBlended, bg);
            const fontPx = parseFloat(style.fontSize || '16');
            const weight = Number(style.fontWeight || '400');
            const isLarge = fontPx >= 24 || (fontPx >= 18.66 && weight >= 700);
            const required = isLarge ? minLarge : minNormal;
            if (ratio < required) {
                contrastViolations.push({
                    tag: node.tagName.toLowerCase(),
                    text: directText.slice(0, 40),
                    ratio,
                    required,
                    fg: style.color,
                    bg: `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`
                });
            }
        }
        // 3. Focus visible check on first visible focusable control
        let focusVisibleOk = true;
        let focusReason = 'No visible focusable element found.';
        const focusables = Array.from(document.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        const focusable = focusables.find((el) => {
            const st = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return (st.display !== 'none' && st.visibility !== 'hidden' && rect.width > 0 && rect.height > 0);
        });
        if (focusable) {
            const prev = document.activeElement;
            focusable.focus({ preventScroll: true });
            const fs = getComputedStyle(focusable);
            const outlineW = parseFloat(fs.outlineWidth || '0');
            const hasOutline = fs.outlineStyle !== 'none' && outlineW > 0;
            const hasShadow = fs.boxShadow !== 'none' && fs.boxShadow !== '';
            focusVisibleOk = hasOutline || hasShadow;
            focusReason = focusVisibleOk
                ? `Focus ring detected (${hasOutline ? `outline ${fs.outlineWidth}` : 'box-shadow'}).`
                : `Focused <${focusable.tagName.toLowerCase()}> has no visible outline or focus ring.`;
            if (prev && typeof prev.focus === 'function')
                prev.focus({ preventScroll: true });
        }
        // 4. Reduced motion media query / unguarded animation check (recurses into nested CSSGroupingRule such as Tailwind @layer)
        const inspectRulesForReducedMotion = (list) => {
            if (!list)
                return false;
            for (const rule of Array.from(list)) {
                if ('conditionText' in rule &&
                    typeof rule.conditionText === 'string' &&
                    rule.conditionText.includes('prefers-reduced-motion')) {
                    return true;
                }
                if ('cssRules' in rule) {
                    const nested = rule.cssRules;
                    if (nested && inspectRulesForReducedMotion(nested))
                        return true;
                }
            }
            return false;
        };
        let hasReducedMotionRule = false;
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                if (inspectRulesForReducedMotion(sheet.cssRules)) {
                    hasReducedMotionRule = true;
                    break;
                }
            }
            catch {
                /* Cross-origin stylesheet skipped */
            }
        }
        const mqReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        let unboundedTransitions = 0;
        if (!hasReducedMotionRule && mqReduced) {
            for (const el of Array.from(document.querySelectorAll('*'))) {
                const td = parseFloat(getComputedStyle(el).transitionDuration || '0');
                if (td > 0.05)
                    unboundedTransitions++;
            }
        }
        const reducedMotionSupported = hasReducedMotionRule || !mqReduced || unboundedTransitions === 0;
        const scrollWidth = Math.round(document.documentElement.scrollWidth);
        const innerWidth = window.innerWidth;
        const overflowPx = Math.max(0, scrollWidth - innerWidth);
        const sidewaysScroll = {
            scrollWidth,
            innerWidth,
            overflowPx,
            passed: overflowPx === 0
        };
        const measuredLoadedHeightPx = Math.round(document.documentElement.scrollHeight);
        return {
            sidewaysScroll,
            buttonChromeViolations,
            contrastViolations,
            focusVisibleOk,
            focusReason,
            reducedMotionSupported,
            unboundedTransitions,
            measuredLoadedHeightPx
        };
    }, {
        minContrastNormal,
        minContrastLarge,
        allowDefaultChrome: Boolean(opts.allowDefaultButtonChrome)
    });
    const filteredConsoleErrors = filterConsoleErrors(opts.consoleErrors ?? [], opts.ignoreConsolePatterns ?? []);
    const loadedHeightPx = opts.loadedHeightPx ?? domProbe.measuredLoadedHeightPx;
    const skeletonCheck = evaluateSkeletonHeight(opts.skeletonHeightPx, loadedHeightPx, maxSkeletonDelta);
    const checks = {
        cls: {
            kind: 'cls',
            passed: early.cls.passed,
            summary: early.cls.passed
                ? `CLS ${early.cls.score} <= ${early.cls.maxCls} on ${screen}/${state}.`
                : `CLS ${early.cls.score} > ${early.cls.maxCls} on ${screen}/${state}.`,
            measured: { score: early.cls.score, max: early.cls.maxCls }
        },
        'tap-targets': {
            kind: 'tap-targets',
            passed: early.tapTargets.passed,
            summary: early.tapTargets.passed
                ? `All ${early.tapTargets.total} interactive targets meet ${early.tapTargets.minTapPx}px.`
                : `${early.tapTargets.violations.length} target(s) below ${early.tapTargets.minTapPx}px.`,
            measured: {
                checked: early.tapTargets.total,
                minPx: early.tapTargets.minTapPx,
                violations: early.tapTargets.violations.length
            },
            violations: early.tapTargets.violations
        },
        'sideways-scroll': {
            kind: 'sideways-scroll',
            passed: domProbe.sidewaysScroll.passed,
            summary: domProbe.sidewaysScroll.passed
                ? `No sideways overflow (scrollWidth=${domProbe.sidewaysScroll.scrollWidth}, innerWidth=${domProbe.sidewaysScroll.innerWidth}).`
                : `Sideways overflow of ${domProbe.sidewaysScroll.overflowPx}px.`,
            measured: { ...domProbe.sidewaysScroll }
        },
        'button-chrome': {
            kind: 'button-chrome',
            passed: domProbe.buttonChromeViolations.length === 0,
            summary: domProbe.buttonChromeViolations.length === 0
                ? 'No unstyled default browser button chrome found.'
                : `${domProbe.buttonChromeViolations.length} button(s) show default browser chrome.`,
            measured: { count: domProbe.buttonChromeViolations.length },
            violations: domProbe.buttonChromeViolations
        },
        'contrast-pairs': {
            kind: 'contrast-pairs',
            passed: domProbe.contrastViolations.length === 0,
            summary: domProbe.contrastViolations.length === 0
                ? 'All sampled visible text pairs meet WCAG contrast.'
                : `${domProbe.contrastViolations.length} text element(s) below contrast threshold.`,
            measured: { count: domProbe.contrastViolations.length },
            violations: domProbe.contrastViolations
        },
        'skeleton-height': skeletonCheck,
        'focus-visible': {
            kind: 'focus-visible',
            passed: domProbe.focusVisibleOk,
            summary: domProbe.focusReason,
            measured: { passed: domProbe.focusVisibleOk }
        },
        'reduced-motion': {
            kind: 'reduced-motion',
            passed: domProbe.reducedMotionSupported,
            summary: domProbe.reducedMotionSupported
                ? 'Reduced-motion handling satisfied.'
                : `${domProbe.unboundedTransitions} element(s) animate under prefers-reduced-motion.`,
            measured: {
                passed: domProbe.reducedMotionSupported,
                unboundedTransitions: domProbe.unboundedTransitions
            }
        },
        'console-errors': {
            kind: 'console-errors',
            passed: filteredConsoleErrors.length === 0,
            summary: filteredConsoleErrors.length === 0
                ? 'Zero console or uncaught page errors.'
                : `${filteredConsoleErrors.length} console/page error(s) captured.`,
            measured: { count: filteredConsoleErrors.length },
            violations: filteredConsoleErrors
        }
    };
    const passed = Object.values(checks).every((c) => c.passed);
    return {
        version: STOCK_VISUAL_CHECKS_VERSION,
        screen,
        state,
        width: opts.width ?? null,
        passed,
        checks,
        tapViolations: early.tapTargets.violations,
        contrastViolations: domProbe.contrastViolations,
        buttonChromeViolations: domProbe.buttonChromeViolations,
        consoleErrors: filteredConsoleErrors
    };
}
/** Formats a StockVisualCheckReport into concise, readable log lines. */
export function formatStockVisualReport(report) {
    const head = `[stock-visual v${report.version}] ${report.screen}/${report.state}${report.width ? `@${report.width}px` : ''} - ${report.passed ? 'PASS' : 'FAIL'}`;
    const lines = Object.values(report.checks).map((c) => `  [${c.passed ? 'PASS' : 'FAIL'}] ${c.kind} - ${c.summary}`);
    return [head, ...lines];
}
export { EARLY_CLS_INIT_SCRIPT, resetEarlyCls };
