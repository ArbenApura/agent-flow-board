// agent-flow-board mockup push ... --renders: WHAT A BROWSER SAW OF EVERY SCREEN, SAVED WITH THE VERSION (AFB-20261114-0409, C.2)
// After a push the page is opened (the signed address on the isolated mockup host, a fresh context with no sign in) at each width,
// one screen after the other, and the picture and the rendered element tree of each are uploaded. The tree comes from the page as
// it is drawn, so markup built by script is in it, which the server's outline cannot see. A render that fails is said, never fatal.
// -- MODULES -- //
import { inspectUrl } from './checks/inspect.js';
import { resolveMockupTarget } from './checks/mockupTarget.js';
import { call, failure } from './mockup.js';
// -- CONSTANTS -- //
export const DEFAULT_RENDER_WIDTHS = [408, 820, 1280, 1600];
const MAX_ELEMENTS = 400;
const REMINT_EVERY = 16;
// -- FUNCTIONS -- //
/** The screen keys a page declares in its afb-config meta tag, in the order it lists them. */
export function screensOfPage(html) {
    const tag = /<meta\b[^>]*\bname\s*=\s*["']afb-config["'][^>]*>/i.exec(html)?.[0];
    if (!tag)
        return [];
    const raw = /\bcontent\s*=\s*(?:'([^']*)'|"([^"]*)")/i.exec(tag);
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse((raw[1] ?? raw[2] ?? '').replace(/&quot;/g, '"'));
        if (!Array.isArray(parsed.screens))
            return [];
        return parsed.screens
            .map((s) => (Array.isArray(s) ? String(s[0]) : String(s)))
            .filter((k) => /^[a-z0-9_-]{1,40}$/i.test(k))
            .slice(0, 12);
    }
    catch {
        return [];
    }
}
/** Opens every screen at every width, and uploads the picture and the tree of each. */
export async function captureRenders(o) {
    const screens = o.screens.length ? o.screens : [''];
    const states = ['default', ...(o.states ?? [])];
    const result = { captured: 0, failed: [] };
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
                    const shot = await inspectUrl({
                        url: minted.url,
                        expectedOrigin: minted.origin,
                        target: 'mockup',
                        screen: screen || undefined,
                        state: state === 'default' ? undefined : state,
                        width,
                        captureScreenshot: true
                    });
                    const elements = shot.dump.elements.slice(0, MAX_ELEMENTS).map((e) => ({
                        ...e,
                        text: typeof e.text === 'string' ? e.text.slice(0, 120) : e.text
                    }));
                    const res = await call(o, 'PUT', `/orgs/${encodeURIComponent(o.org)}/mockups/${o.mockup}/versions/${o.version}/renders`, JSON.stringify({
                        screen: label,
                        state,
                        width,
                        ...(shot.screenshot ? { pngBase64: shot.screenshot.toString('base64') } : {}),
                        elements
                    }), { 'content-type': 'application/json' }, `mockup-render-${o.mockup}-${o.version}-${label}-${state}-${width}`);
                    if (!res.ok)
                        throw new Error(await failure(res));
                    result.captured++;
                }
                catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    result.failed.push({ screen: label, width, reason: reason.slice(0, 200) });
                    o.log(`Render of ${label} at ${width} failed: ${reason.slice(0, 200)}`);
                }
            }
    return result;
}
async function mint(o) {
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
