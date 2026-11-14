// RESOLVES AND VALIDATES `--mockup ID[@VERSION]` TARGETS FOR ISOLATED MOCKUP CHECKS AND INSPECTIONS.
// -- MODULES -- //
import { mintMockupUrlCli } from '../mockup.js';
import { RunnerBoard } from './board.js';
// -- CONSTANTS -- //
const MOCKUP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// -- FUNCTIONS -- //
/** Parses `<ID>` or `<ID>@<VERSION>` (positive integer >= 1). Throws one plain sentence on invalid input. */
export function parseMockupRef(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new Error('Say --mockup <id> or --mockup <id>@<version>.');
    const at = trimmed.lastIndexOf('@');
    if (at === -1) {
        if (!MOCKUP_ID_RE.test(trimmed))
            throw new Error(`Invalid mockup reference "${trimmed.slice(0, 60)}".`);
        return { id: trimmed, raw: trimmed };
    }
    const id = trimmed.slice(0, at);
    const verRaw = trimmed.slice(at + 1);
    if (!id || !MOCKUP_ID_RE.test(id))
        throw new Error(`Invalid mockup reference "${trimmed.slice(0, 60)}".`);
    if (!/^[1-9]\d{0,5}$/.test(verRaw))
        throw new Error(`Mockup version after "@" must be a whole number from 1 up, not "${verRaw.slice(0, 20)}".`);
    return { id, version: Number.parseInt(verRaw, 10), raw: trimmed };
}
/**
 * Mints a short-lived signed mockup URL using either the runner token (via RunnerBoard)
 * or the personal token (via the org endpoint), returning the normalized origin and URL.
 */
export async function resolveMockupTarget(opts) {
    if (!opts.server)
        throw new Error('A hosted --mockup target needs a board server address (--server).');
    const { id, version } = opts.ref;
    const minted = opts.runnerToken
        ? await new RunnerBoard(opts.server, opts.runnerToken, opts.fetch).mintMockupUrl(id, {
            ...(version !== undefined ? { version } : {}),
            ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {})
        })
        : await mintMockupUrlCli({
            server: opts.server,
            org: opts.org,
            mockup: id,
            ...(version !== undefined ? { version } : {}),
            ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
            token: opts.personalToken ?? '',
            fetch: opts.fetch
        });
    const resolvedUrl = new URL(minted.url, opts.server);
    if (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:') {
        throw new Error(`Refused non-HTTP mockup target protocol "${resolvedUrl.protocol}".`);
    }
    return {
        url: resolvedUrl.toString(),
        origin: resolvedUrl.origin,
        hostname: resolvedUrl.hostname,
        mockupId: minted.mockupId,
        projectId: minted.projectId,
        version: minted.version,
        isolatedOrigin: minted.isolatedOrigin,
        notice: minted.notice,
        isPublic: minted.isPublic
    };
}
