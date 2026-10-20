// READ THE SKILLS A CHECKOUT SHOULD CARRY, OVER THE BOARD'S OWN REST API (AFB-20261018-0622)
// The bridge holds no tool code and no schema of its own, so it reads the same routes a person's browser does.
// -- MODULES -- //
import { filePathError, skillHashOf } from './materialize.js';
export class SkillSourceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SkillSourceError';
    }
}
// -- FUNCTIONS -- //
/** One GET that returns JSON, with the server's plain error message when it refuses. */
async function getJson(o, path) {
    const res = await o.fetch(`${o.server}${path}`, {
        headers: { authorization: `Bearer ${o.token}`, accept: 'application/json' }
    });
    const body = (await res.json().catch(() => null));
    if (!res.ok)
        throw new SkillSourceError(body?.error?.message ?? `The board answered ${res.status} for ${path}.`);
    return body;
}
/** The organisation the token belongs to, by slug. */
export async function resolveOrg(o) {
    if (o.org)
        return o.org;
    const me = await getJson(o, '/api/v1/me');
    if (me.orgs.length === 1)
        return me.orgs[0].slug;
    if (!me.orgs.length)
        throw new SkillSourceError('This token belongs to no organisation.');
    throw new SkillSourceError(`This token reaches ${me.orgs.length} organisations. Name one with --org.`);
}
/** Every skill of the project (and its organisation), with the whole text, read page by page. */
export async function fetchSkills(o) {
    const org = await resolveOrg(o);
    const base = `/api/v1/orgs/${org}${o.project ? `/projects/${o.project}` : ''}/skills`;
    const list = await getJson(o, base);
    const out = [];
    for (const s of list) {
        // The name becomes a path in the checkout, so anything that is not a plain slug is refused before it is written
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(s.name))
            throw new SkillSourceError(`The board returned a skill name that is not a slug: "${s.name}".`);
        // Every path is checked here too: the board is trusted for the text, but a path is written onto this disk
        for (const f of s.files ?? []) {
            const bad = filePathError(f.path);
            if (bad)
                throw new SkillSourceError(`The board returned an unsafe file path for "${s.name}": ${bad}`);
        }
        // The revision pins every page, so a save in the middle answers CONFLICT instead of joining two versions
        const readText = async (file) => {
            let offset = 0;
            let text = '';
            let hash = s.hash;
            for (;;) {
                const page = await getJson(o, `${base}/${encodeURIComponent(s.name)}?offset=${offset}&revision=${s.revision}${file === undefined ? '' : `&file=${encodeURIComponent(file)}`}`);
                text += page.text;
                hash = page.hash ?? hash;
                if (page.next === null)
                    break;
                offset = page.next;
            }
            return { text, hash };
        };
        const main = await readText();
        const files = [];
        for (const f of s.files ?? [])
            files.push({ path: f.path, body: (await readText(f.path)).text });
        // With files the hash covers them too, so a file that changed between two reads is caught here, not written
        if (files.length &&
            skillHashOf({ name: s.name, summary: s.summary, body: main.text }, files) !== main.hash)
            throw new SkillSourceError(`"${s.name}" changed while it was being read, or its files do not match the board's hash. Run it again.`);
        out.push({
            name: s.name,
            summary: s.summary,
            body: main.text,
            hash: main.hash,
            ...(files.length ? { files } : {})
        });
    }
    return out;
}
