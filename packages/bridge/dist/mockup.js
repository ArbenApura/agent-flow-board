// agent-flow-board mockup push <file.html>: UPLOADS ONE MOCKUP FILE TO THE BOARD OVER /api/v1 WITH THE BRIDGE'S OWN SIGN IN
// It reads the file by path from the agent's own folder, so the HTML never passes through a model's output. It is never queued, never
// goes through the MCP forwarder and changes nothing in the bridge protocol: a failed push says so and the agent runs it again.
// -- DEP-MODULES -- //
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
// -- CONSTANTS -- //
/** The server's own cap for one version (50 MB). The server checks it again, this only stops a hopeless upload early. */
export const MAX_MOCKUP_BYTES = 50 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const TRIES = 3;
/** A kit's summary travels in the address, so it is kept short here. */
const MAX_KIT_SUMMARY = 4000;
// -- FUNCTIONS -- //
/** The message of a failed call: the server's own words when it sent them. */
async function failure(res) {
    try {
        const j = (await res.json());
        if (j.error?.message)
            return `${j.error.message} (${res.status})`;
    }
    catch {
        /* Not JSON */
    }
    return `The server answered ${res.status}.`;
}
/** Only a plain HTML or PNG file of a sane size is read: never a link, a folder or some other file an agent was talked into naming. */
function readFileChecked(path, kinds, max, what) {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st)
        throw new Error(`The ${what} file ${path} does not exist.`);
    if (!st.isFile())
        throw new Error(`The ${what} path ${path} is not a plain file.`);
    if (!kinds.includes(extname(path).toLowerCase()))
        throw new Error(`The ${what} must be a ${kinds.join(' or ')} file.`);
    if (st.size === 0)
        throw new Error(`The ${what} file is empty.`);
    if (st.size > max)
        throw new Error(`The ${what} is ${Math.ceil(st.size / 1024 / 1024)} MB, more than the ${Math.floor(max / 1024 / 1024)} MB limit.`);
    return new Uint8Array(readFileSync(path));
}
/** One call, tried again on a network failure or a 5xx with the same request id, so a repeat can never publish twice. */
async function call(o, method, path, body, headers, requestId) {
    let last = 'The server could not be reached.';
    for (let i = 0; i < TRIES; i++) {
        try {
            const res = await o.fetch(`${o.server}/api/v1${path}`, {
                method,
                body,
                headers: {
                    authorization: `Bearer ${o.token}`,
                    'idempotency-key': requestId,
                    ...headers
                }
            });
            if (res.status < 500)
                return res;
            last = await failure(res);
        }
        catch (e) {
            last = e instanceof Error ? e.message : String(e);
        }
        if (i < TRIES - 1)
            await (o.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(500 * (i + 1));
    }
    throw new Error(last);
}
export async function pushMockup(o) {
    if (!o.token)
        throw new Error('Not signed in. Run: agent-flow-board login --server <url> --org <slug>');
    if (!o.item && !o.project && !o.mockup)
        throw new Error('Name the plan (--item), a project (--project) or the mockup (--mockup).');
    const html = readFileChecked(o.file, ['.html', '.htm'], MAX_MOCKUP_BYTES, 'mockup');
    const shot = o.screenshot
        ? readFileChecked(o.screenshot, ['.png'], MAX_SCREENSHOT_BYTES, 'screenshot')
        : null;
    const id = randomBytes(8).toString('hex');
    const base = `/orgs/${encodeURIComponent(o.org)}`;
    const q = new URLSearchParams();
    for (const [k, v] of [
        ['item', o.item],
        ['project', o.project],
        ['mockup', o.mockup],
        ['title', o.title]
    ])
        if (v)
            q.set(k, v);
    if (o.another)
        q.set('another', 'true');
    const res = await call(o, 'POST', `${base}/mockups?${q}`, html, { 'content-type': 'text/html' }, `mockup-push-${id}`);
    if (!res.ok)
        throw new Error(await failure(res));
    const made = (await res.json());
    const at = `${base}/mockups/${made.mockup.id}/versions/${made.version.number}`;
    let notes = false;
    if (o.keepNotes || o.freeNotes) {
        const n = await call(o, 'PUT', `${at}/notes`, JSON.stringify({ keepNotes: o.keepNotes ?? '', freeNotes: o.freeNotes ?? '' }), { 'content-type': 'application/json' }, `mockup-notes-${id}`);
        if (!n.ok)
            o.log(`The mockup is published, but its notes were not saved: ${await failure(n)}`);
        else
            notes = true;
    }
    let screenshot = false;
    if (shot) {
        const s = await call(o, 'PUT', `${at}/screenshot`, shot, { 'content-type': 'image/png' }, `mockup-shot-${id}`);
        if (!s.ok)
            o.log(`The mockup is published, but its screenshot was not saved: ${await failure(s)}`);
        else
            screenshot = true;
    }
    const warnings = made.warnings ?? [];
    for (const w of warnings)
        o.log(`Warning: ${w}`);
    return {
        mockupId: made.mockup.id,
        version: made.version.number,
        url: `${o.server}/${o.org}/${made.projectKey}/mockups/${made.mockup.id}`,
        notes,
        screenshot,
        warnings
    };
}
/** Uploads the project's kit file (colours, fonts, icons) by path, the same way. The warnings are printed and never change the exit code. */
export async function pushKit(o) {
    if (!o.token)
        throw new Error('Not signed in. Run: agent-flow-board login --server <url> --org <slug>');
    const html = readFileChecked(o.file, ['.html', '.htm'], MAX_MOCKUP_BYTES, 'kit');
    const q = new URLSearchParams();
    if (o.commit)
        q.set('builtFromCommit', o.commit.slice(0, 80));
    if (o.summary) {
        if (o.summary.length > MAX_KIT_SUMMARY)
            throw new Error(`The summary is ${o.summary.length.toLocaleString('en-US')} characters; the bridge sends at most ${MAX_KIT_SUMMARY.toLocaleString('en-US')}. Shorten it.`);
        q.set('summary', o.summary);
    }
    const res = await call(o, 'PUT', `/orgs/${encodeURIComponent(o.org)}/projects/${encodeURIComponent(o.project)}/mockup-kit?${q}`, html, { 'content-type': 'text/html' }, `mockup-kit-${randomBytes(8).toString('hex')}`);
    if (!res.ok)
        throw new Error(await failure(res));
    const made = (await res.json());
    const warnings = made.warnings ?? [];
    for (const w of warnings)
        o.log(`Warning: ${w}`);
    return { number: made.number, warnings };
}
