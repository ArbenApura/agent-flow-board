// PAIRING CONTRACT AND NORMALISATION FOR INSPECT AND COMPARE (STEP B.8, AFB-20261113-1008)
// Defines how mockup elements (data-ref) pair with app selectors, how screens/states are driven, how computed
// colours/fonts/spacing are normalised against resolved tokens, and how Free exemptions + per-plan overrides work.
// Crucial invariant: anything not paired (missing ref, missing app element, manual state) is reported in notCompared, never as a pass.
export const INSPECT_STYLE_PROPERTIES = [
    'display',
    'borderTopWidth',
    'borderTopStyle',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'borderRadius',
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'borderBottomRightRadius',
    'borderBottomLeftRadius',
    'backgroundColor',
    'color',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'padding',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'gap',
    'rowGap',
    'columnGap',
    'opacity'
];
// -- CONSTANTS -- //
export const DEFAULT_COMPARE_TOLERANCES = {
    positionPx: 2,
    sizePx: 2,
    radiusPx: 1,
    paddingPx: 1,
    gapPx: 1,
    colorChannelDelta: 0,
    opacityDelta: 0.01,
    fontSizePx: 0
};
const COMPARE_PROPERTY_SEVERITY = {
    text: 'high',
    display: 'high',
    fontFamily: 'high',
    fontSize: 'high',
    fontWeight: 'high',
    color: 'high',
    backgroundColor: 'high',
    borderColor: 'medium',
    w: 'medium',
    h: 'medium',
    x: 'medium',
    y: 'medium',
    borderRadius: 'low',
    padding: 'low',
    gap: 'low',
    opacity: 'low'
};
// -- FUNCTIONS: STATE DRIVING -- //
/**
 * Builds the URL to reach a given screen/state on either the mockup or the app under the pairing contract.
 * Manual states cannot be driven purely by URL and return manualRequired=true.
 */
export function applyStateDriverToUrl(baseUrl, screen, driver) {
    const u = new URL(baseUrl);
    const mode = driver?.mode ?? 'query';
    if (mode === 'manual' || (mode === 'route-mock' && !driver?.routePattern)) {
        return { url: u.toString(), manualRequired: true, mode };
    }
    if (mode === 'profile' || mode === 'route-mock') {
        if (screen)
            u.searchParams.set('screen', screen);
        return { url: u.toString(), manualRequired: false, mode };
    }
    const key = driver?.param || 'state';
    const val = driver?.value || driver?.state || 'default';
    if (mode === 'hash') {
        const params = new URLSearchParams(u.hash.startsWith('#') ? u.hash.slice(1) : u.hash);
        if (screen)
            params.set('screen', screen);
        if (driver?.state)
            params.set(key, val);
        u.hash = `#${params.toString()}`;
    }
    else {
        if (screen)
            u.searchParams.set('screen', screen);
        if (driver?.state)
            u.searchParams.set(key, val);
    }
    return { url: u.toString(), manualRequired: false, mode };
}
// -- FUNCTIONS: NORMALISATION -- //
const HEX_SHORT = /^#([0-9a-f]{3,4})$/i;
const HEX_LONG = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const RGB_COMMA = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+%?)\s*)?\)$/i;
const RGB_SPACE = /^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+%?)\s*)?\)$/i;
const parseAlpha = (raw) => {
    if (!raw)
        return 1;
    const trimmed = raw.trim();
    const n = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed);
    if (!Number.isFinite(n))
        return 1;
    return Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));
};
/** Resolves a var(--token) expression if present in the supplied token table. */
export function resolveTokenValue(raw, tokens) {
    const trimmed = raw.trim();
    if (!tokens)
        return trimmed;
    const varMatch = /^var\(\s*(--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\s*\)$/i.exec(trimmed);
    if (!varMatch)
        return trimmed;
    const resolved = tokens[varMatch[1]];
    if (resolved)
        return resolved.trim();
    return varMatch[2]?.trim() ?? trimmed;
}
/** Parses CSS computed colour values (rgb/rgba, space syntax, hex, transparent) or token references to RGBA. */
export function normalizeColor(raw, tokens) {
    const val = resolveTokenValue(raw, tokens).toLowerCase();
    if (!val || val === 'none')
        return null;
    if (val === 'transparent')
        return { r: 0, g: 0, b: 0, a: 0 };
    const hs = HEX_SHORT.exec(val);
    if (hs) {
        const digits = hs[1];
        const r = parseInt(digits[0] + digits[0], 16);
        const g = parseInt(digits[1] + digits[1], 16);
        const b = parseInt(digits[2] + digits[2], 16);
        const a = digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1;
        return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    const hl = HEX_LONG.exec(val);
    if (hl) {
        const hex = hl[1];
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        const a = hl[2] ? parseInt(hl[2], 16) / 255 : 1;
        return { r, g, b, a: Math.round(a * 1000) / 1000 };
    }
    const m = RGB_COMMA.exec(val) ?? RGB_SPACE.exec(val);
    if (!m)
        return null;
    const r = Math.round(Number(m[1]));
    const g = Math.round(Number(m[2]));
    const b = Math.round(Number(m[3]));
    const a = parseAlpha(m[4]);
    if ([r, g, b].some((n) => !Number.isFinite(n)))
        return null;
    return { r, g, b, a };
}
export function formatRgba(c) {
    return c.a === 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}
export function colorsMatch(aRaw, bRaw, channelDelta = 0, opacityDelta = 0.01, tokens) {
    const a = normalizeColor(aRaw, tokens);
    const b = normalizeColor(bRaw, tokens);
    if (!a || !b) {
        const sA = resolveTokenValue(aRaw, tokens).toLowerCase();
        const sB = resolveTokenValue(bRaw, tokens).toLowerCase();
        return { equal: sA === sB, normA: sA, normB: sB, delta: sA === sB ? 0 : 255 };
    }
    // Fully transparent colours are visually identical regardless of RGB channels
    if (a.a === 0 && b.a === 0) {
        return { equal: true, normA: 'transparent', normB: 'transparent', delta: 0 };
    }
    const rgbDiff = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
    const aDiff = Math.abs(a.a - b.a);
    const equal = rgbDiff <= channelDelta && aDiff <= opacityDelta;
    return { equal, normA: formatRgba(a), normB: formatRgba(b), delta: rgbDiff };
}
/** Normalises a CSS font-family stack so quotes, casing and whitespace compare consistently. */
export function normalizeFontFamily(raw, tokens) {
    const resolved = resolveTokenValue(raw, tokens);
    return resolved
        .split(',')
        .map((part) => part
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase())
        .filter(Boolean)
        .join(', ');
}
export function primaryFontFamily(raw, tokens) {
    return normalizeFontFamily(raw, tokens).split(',')[0]?.trim() ?? '';
}
export function normalizeFontWeight(raw) {
    const val = raw.trim().toLowerCase();
    if (val === 'normal')
        return '400';
    if (val === 'bold')
        return '700';
    return val;
}
export function parsePx(raw, tokens) {
    const val = resolveTokenValue(raw, tokens).trim().toLowerCase();
    if (val === '0')
        return 0;
    const m = /^(-?[0-9]+(?:\.[0-9]+)?)px$/.exec(val);
    if (!m)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
/** Expands 1-4 value CSS px shorthands (padding, borderRadius) into [top, right, bottom, left]. */
export function expandPxBox(raw) {
    const parts = raw
        .trim()
        .split(/\s+/)
        .map((p) => parsePx(p))
        .filter((n) => n !== null);
    if (parts.length === 0 || parts.length > 4)
        return null;
    if (parts.length === 1)
        return [parts[0], parts[0], parts[0], parts[0]];
    if (parts.length === 2)
        return [parts[0], parts[1], parts[0], parts[1]];
    if (parts.length === 3)
        return [parts[0], parts[1], parts[2], parts[1]];
    return [parts[0], parts[1], parts[2], parts[3]];
}
// -- FUNCTIONS: FREE LIST & DESIGN-BRIEF PARSING -- //
/**
 * Parses a structured Free list and Pairing table out of the design-brief markdown section.
 * Accepts bullet lines or JSON blocks describing exempted (ref, property, reason) entries.
 */
export function parseFreeRulesFromBrief(briefBody) {
    const out = [];
    const seen = new Set();
    const pushRule = (ref, property, reason) => {
        const cleanRef = ref.trim();
        const cleanProp = property.trim();
        const cleanReason = reason.trim();
        if (!cleanRef || !cleanProp || !cleanReason)
            return;
        const key = `${cleanRef}::${cleanProp.toLowerCase()}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({ ref: cleanRef, property: cleanProp, reason: cleanReason });
    };
    for (const line of briefBody.split(/\r?\n/)) {
        const trimmed = line.trim();
        // Matches: - ref | property | reason  OR  * data-ref="foo" | color, backgroundColor | reason
        const pipe = /^(?:[-*]|\d+\.)\s+(?:data-ref=["']?)?([a-z0-9._-]+)["']?\s*\|\s*([a-z0-9,.*_\s-]+?)\s*\|\s*(.+)$/i.exec(trimmed);
        if (pipe) {
            for (const prop of pipe[2].split(',').map((p) => p.trim())) {
                if (prop)
                    pushRule(pipe[1], prop, pipe[3]);
            }
            continue;
        }
        // Matches table row inside design-brief Free section: | foo | backgroundColor | illustration exemption |
        const row = /^\|\s*(?:data-ref=["']?)?([a-z0-9._-]+)["']?\s*\|\s*([a-z0-9,.*_\s-]+?)\s*\|\s*([^|]+)\s*\|$/i.exec(trimmed);
        if (row && !/^(ref|selector|-+)$/i.test(row[1])) {
            for (const prop of row[2].split(',').map((p) => p.trim())) {
                if (prop)
                    pushRule(row[1], prop, row[3]);
            }
        }
    }
    return out;
}
// -- FUNCTIONS: COMPARISON -- //
const normText = (raw) => raw.replace(/\s+/g, ' ').trim();
function findWaiver(ref, property, free, overrides) {
    const propLower = property.toLowerCase();
    for (const rule of free) {
        if (rule.ref !== ref && rule.ref !== '*')
            continue;
        const rLower = rule.property.toLowerCase();
        if (rLower === propLower || rLower === '*') {
            return { kind: 'free', reason: rule.reason };
        }
    }
    for (const ov of overrides) {
        if (!ov.reason.trim())
            continue;
        if (ov.ref !== ref && ov.ref !== '*')
            continue;
        const oLower = ov.property.toLowerCase();
        if (oLower === propLower || oLower === '*') {
            return { kind: 'override', reason: ov.reason, tolerancePx: ov.tolerancePx };
        }
    }
    return null;
}
/**
 * Compares a mockup inspect dump and an app inspect dump under the PairingManifest rules.
 * Every element not paired or absent on either side lands in notCompared (and prevents passing).
 */
export function compareInspections(mockup, app, manifest) {
    const tol = { ...DEFAULT_COMPARE_TOLERANCES, ...manifest.tolerances };
    const free = manifest.free ?? [];
    const overrides = manifest.overrides ?? [];
    const mismatches = [];
    const waived = [];
    const notCompared = [];
    const tokens = manifest.tokens;
    const driver = manifest.stateDrivers?.find((d) => d.state === mockup.state);
    if (driver?.mode === 'manual') {
        notCompared.push({
            ref: '*',
            reason: 'manual-state-required',
            detail: driver.instructions || `State "${mockup.state}" requires manual setup.`
        });
    }
    if (manifest.pairs.length === 0) {
        notCompared.push({
            ref: '*',
            reason: 'no-pairs-declared',
            detail: 'No element pairs (data-ref -> appSelector) were declared for this screen.'
        });
    }
    const mockByRef = new Map(mockup.elements.map((e) => [e.ref, e]));
    const appByRef = new Map(app.elements.map((e) => [e.ref, e]));
    const pairedRefs = new Set(manifest.pairs.map((p) => p.ref));
    for (const extraRef of mockup.unlistedRefs ?? []) {
        if (!pairedRefs.has(extraRef)) {
            notCompared.push({
                ref: extraRef,
                reason: 'unmapped-mockup-ref',
                detail: `Mockup has data-ref="${extraRef}" with no pair in the pairing manifest.`
            });
        }
    }
    let comparedCount = 0;
    let matchedCount = 0;
    const recordDiff = (ref, appSelector, property, mockupValue, appValue, delta, baseTolerance) => {
        const waiver = findWaiver(ref, property, free, overrides);
        const severity = COMPARE_PROPERTY_SEVERITY[property] ?? 'medium';
        if (waiver) {
            if (waiver.kind === 'override' && waiver.tolerancePx !== undefined && delta !== undefined) {
                if (delta <= waiver.tolerancePx) {
                    waived.push({
                        ref,
                        appSelector,
                        property,
                        mockupValue,
                        appValue,
                        delta,
                        tolerance: waiver.tolerancePx,
                        severity,
                        waived: { kind: 'override', reason: waiver.reason }
                    });
                    return;
                }
            }
            else {
                waived.push({
                    ref,
                    appSelector,
                    property,
                    mockupValue,
                    appValue,
                    delta,
                    tolerance: baseTolerance,
                    severity,
                    waived: { kind: waiver.kind, reason: waiver.reason }
                });
                return;
            }
        }
        mismatches.push({
            ref,
            appSelector,
            property,
            mockupValue,
            appValue,
            delta,
            tolerance: baseTolerance,
            severity
        });
    };
    for (const pair of manifest.pairs) {
        if (pair.screen && pair.screen !== mockup.screen)
            continue;
        if (pair.states && pair.states.length > 0 && !pair.states.includes(mockup.state))
            continue;
        const mEl = mockByRef.get(pair.ref);
        const aEl = appByRef.get(pair.ref);
        if (!mEl || !mEl.present) {
            notCompared.push({
                ref: pair.ref,
                appSelector: pair.appSelector,
                reason: 'missing-in-mockup',
                detail: `Mockup is missing [data-ref="${pair.ref}"].`
            });
            continue;
        }
        if (!aEl || !aEl.present) {
            notCompared.push({
                ref: pair.ref,
                appSelector: pair.appSelector,
                reason: 'missing-in-app',
                detail: `App is missing selector "${pair.appSelector}" for ref "${pair.ref}".`
            });
            continue;
        }
        if (!mEl.visible) {
            notCompared.push({
                ref: pair.ref,
                appSelector: pair.appSelector,
                reason: 'hidden-in-mockup',
                detail: `Mockup element [data-ref="${pair.ref}"] is not visible.`
            });
            continue;
        }
        if (!aEl.visible) {
            notCompared.push({
                ref: pair.ref,
                appSelector: pair.appSelector,
                reason: 'hidden-in-app',
                detail: `App element "${pair.appSelector}" for ref "${pair.ref}" is not visible.`
            });
            continue;
        }
        comparedCount++;
        const mismatchesBefore = mismatches.length;
        // Box position & size (2 px default)
        const boxProps = [
            ['x', tol.positionPx],
            ['y', tol.positionPx],
            ['w', tol.sizePx],
            ['h', tol.sizePx]
        ];
        for (const [key, limit] of boxProps) {
            const mv = Math.round(mEl.box[key]);
            const av = Math.round(aEl.box[key]);
            const diff = Math.abs(mv - av);
            if (diff > limit) {
                recordDiff(pair.ref, pair.appSelector, key, `${mv}px`, `${av}px`, diff, limit);
            }
        }
        // Display
        const mDisplay = (mEl.styles.display ?? '').trim().toLowerCase();
        const aDisplay = (aEl.styles.display ?? '').trim().toLowerCase();
        if (mDisplay && aDisplay && mDisplay !== aDisplay) {
            recordDiff(pair.ref, pair.appSelector, 'display', mDisplay, aDisplay);
        }
        // Colours (exact after normalising), including fallback across border sides
        const mBorderColor = mEl.styles.borderTopColor ||
            mEl.styles.borderRightColor ||
            mEl.styles.borderBottomColor ||
            mEl.styles.borderLeftColor ||
            '';
        const aBorderColor = aEl.styles.borderTopColor ||
            aEl.styles.borderRightColor ||
            aEl.styles.borderBottomColor ||
            aEl.styles.borderLeftColor ||
            '';
        for (const cProp of ['color', 'backgroundColor']) {
            const mVal = mEl.styles[cProp] ?? '';
            const aVal = aEl.styles[cProp] ?? '';
            if (!mVal && !aVal)
                continue;
            const cm = colorsMatch(mVal, aVal, tol.colorChannelDelta, tol.opacityDelta, tokens);
            if (!cm.equal) {
                recordDiff(pair.ref, pair.appSelector, cProp, cm.normA, cm.normB, cm.delta, tol.colorChannelDelta);
            }
        }
        if (mBorderColor || aBorderColor) {
            const cm = colorsMatch(mBorderColor, aBorderColor, tol.colorChannelDelta, tol.opacityDelta, tokens);
            if (!cm.equal) {
                recordDiff(pair.ref, pair.appSelector, 'borderColor', cm.normA, cm.normB, cm.delta, tol.colorChannelDelta);
            }
        }
        // Typography (exact family, size, weight, text)
        if (mEl.styles.fontFamily || aEl.styles.fontFamily) {
            const mf = primaryFontFamily(mEl.styles.fontFamily ?? '', tokens);
            const af = primaryFontFamily(aEl.styles.fontFamily ?? '', tokens);
            if (mf && af && mf !== af) {
                recordDiff(pair.ref, pair.appSelector, 'fontFamily', mf, af);
            }
        }
        if (mEl.styles.fontSize || aEl.styles.fontSize) {
            const ms = parsePx(mEl.styles.fontSize ?? '', tokens);
            const as = parsePx(aEl.styles.fontSize ?? '', tokens);
            if (ms !== null && as !== null) {
                const diff = Math.round(Math.abs(ms - as) * 100) / 100;
                if (diff > tol.fontSizePx) {
                    recordDiff(pair.ref, pair.appSelector, 'fontSize', `${ms}px`, `${as}px`, diff, tol.fontSizePx);
                }
            }
        }
        if (mEl.styles.fontWeight || aEl.styles.fontWeight) {
            const mw = normalizeFontWeight(mEl.styles.fontWeight ?? '');
            const aw = normalizeFontWeight(aEl.styles.fontWeight ?? '');
            if (mw && aw && mw !== aw) {
                recordDiff(pair.ref, pair.appSelector, 'fontWeight', mw, aw);
            }
        }
        const mt = normText(mEl.text);
        const at = normText(aEl.text);
        if (mt !== at) {
            recordDiff(pair.ref, pair.appSelector, 'text', mt, at);
        }
        // Radius (1 px), padding (1 px), gap (1 px), opacity — reconstruct shorthands from longhands when Chromium returns ""
        const boxFromSides = (shortVal, sides) => {
            const direct = expandPxBox(shortVal ?? '');
            if (direct)
                return { raw: shortVal ?? '', vec: direct };
            const vals = sides.map((s) => (s ? parsePx(s) : null));
            if (vals.every((v) => v !== null)) {
                const vec = vals;
                return { raw: `${vec[0]}px ${vec[1]}px ${vec[2]}px ${vec[3]}px`, vec };
            }
            return { raw: shortVal ?? '', vec: null };
        };
        const mRadBox = boxFromSides(mEl.styles.borderRadius, [
            mEl.styles.borderTopLeftRadius,
            mEl.styles.borderTopRightRadius,
            mEl.styles.borderBottomRightRadius,
            mEl.styles.borderBottomLeftRadius
        ]);
        const aRadBox = boxFromSides(aEl.styles.borderRadius, [
            aEl.styles.borderTopLeftRadius,
            aEl.styles.borderTopRightRadius,
            aEl.styles.borderBottomRightRadius,
            aEl.styles.borderBottomLeftRadius
        ]);
        if (mRadBox.vec && aRadBox.vec) {
            const diff = Math.max(...mRadBox.vec.map((v, i) => Math.abs(v - aRadBox.vec[i])));
            if (diff > tol.radiusPx) {
                recordDiff(pair.ref, pair.appSelector, 'borderRadius', mRadBox.raw, aRadBox.raw, diff, tol.radiusPx);
            }
        }
        const mPadBox = boxFromSides(mEl.styles.padding, [
            mEl.styles.paddingTop,
            mEl.styles.paddingRight,
            mEl.styles.paddingBottom,
            mEl.styles.paddingLeft
        ]);
        const aPadBox = boxFromSides(aEl.styles.padding, [
            aEl.styles.paddingTop,
            aEl.styles.paddingRight,
            aEl.styles.paddingBottom,
            aEl.styles.paddingLeft
        ]);
        if (mPadBox.vec && aPadBox.vec) {
            const diff = Math.max(...mPadBox.vec.map((v, i) => Math.abs(v - aPadBox.vec[i])));
            if (diff > tol.paddingPx) {
                recordDiff(pair.ref, pair.appSelector, 'padding', mPadBox.raw, aPadBox.raw, diff, tol.paddingPx);
            }
        }
        const mGap = parsePx((mEl.styles.gap ?? '').replace(/^normal$/i, '0px')) ?? 0;
        const aGap = parsePx((aEl.styles.gap ?? '').replace(/^normal$/i, '0px')) ?? 0;
        const gapDiff = Math.abs(mGap - aGap);
        if ((mEl.styles.gap || aEl.styles.gap) && gapDiff > tol.gapPx) {
            recordDiff(pair.ref, pair.appSelector, 'gap', mEl.styles.gap ?? '0px', aEl.styles.gap ?? '0px', gapDiff, tol.gapPx);
        }
        const mOp = Number(mEl.styles.opacity ?? '1');
        const aOp = Number(aEl.styles.opacity ?? '1');
        if (Number.isFinite(mOp) && Number.isFinite(aOp)) {
            const diff = Math.round(Math.abs(mOp - aOp) * 1000) / 1000;
            if (diff > tol.opacityDelta) {
                recordDiff(pair.ref, pair.appSelector, 'opacity', String(mOp), String(aOp), diff, tol.opacityDelta);
            }
        }
        if (mismatches.length === mismatchesBefore)
            matchedCount++;
    }
    const rank = { high: 0, medium: 1, low: 2 };
    mismatches.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.delta ?? 0) - (a.delta ?? 0));
    // Anything unpaired or uncompared prevents a pass
    const passed = mismatches.length === 0 && notCompared.length === 0 && comparedCount > 0;
    const parts = [
        `${comparedCount} paired, ${matchedCount} matched`,
        `${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}`,
        `${notCompared.length} notCompared`
    ];
    if (waived.length)
        parts.push(`${waived.length} waived`);
    return {
        passed,
        screen: mockup.screen,
        state: mockup.state,
        width: mockup.width,
        comparedCount,
        matchedCount,
        mismatches,
        waived,
        notCompared,
        summary: parts.join(', ')
    };
}
