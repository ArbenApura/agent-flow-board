"use strict";
// MAIL GUARD, THE RUNTIME HOOK. The tool, never a recipe, loads this file into the start step of a preview that has sealed mail settings (NODE_OPTIONS=--require). It stands
// between the app and Postmark: every send to a Postmark host is rewritten to go to the ONE test inbox the owner named, and anything it cannot read and rewrite is refused.
// Each rewrite and each refusal is a line in the run log (addresses masked) and a JSON line in AFB_MAIL_FENCE_LOG, which the tool counts into the run's result.
//
// WHAT THIS DOES AND DOES NOT PROTECT. It is a fence against mistakes (an app that mails the people in a test database), not against the repo's own code: code the agent wrote
// can load another HTTP client, spawn a process or call a mail API this file does not know. The owner's word that the token is a test token is what covers that, and it is in
// the audit chain. This file is CommonJS (a .cts compiled to .cjs) because --require loads CommonJS only; import-equals keeps the real module objects so they can be patched.
Object.defineProperty(exports, "__esModule", { value: true });
// import-equals is the only form that keeps the real CommonJS module objects, so the guard can patch them (a --require hook is CommonJS)
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
// -- CONSTANTS -- //
const INBOX = String(process.env.AFB_MAIL_FENCE_INBOX || '')
    .trim()
    .toLowerCase();
const LOG = process.env.AFB_MAIL_FENCE_LOG || '';
const POSTMARK = /(^|\.)postmarkapp\.com\.?$/i;
const SEND_PATHS = new Set([
    '/email',
    '/email/batch',
    '/email/withtemplate',
    '/email/batchwithtemplates'
]);
const ADDRESS = /[^<>\s,;"]+@[^<>\s,;"]+/g;
// -- FUNCTIONS -- //
const record = (event) => {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event });
    try {
        if (LOG)
            fs.appendFileSync(LOG, line + '\n');
    }
    catch {
        // a log that cannot be written must not take the preview down; the console line below still shows
    }
    if (event.event !== 'loaded' && event.event !== 'listening')
        process.stderr.write(`[afb-checks mail guard] ${event.event}: ${event.note || ''}\n`);
};
const mask = (a) => String(a).replace(/^(.).*@/, '$1***@');
const addresses = (v) => (typeof v === 'string' ? v.match(ADDRESS) || [] : []);
record({
    event: 'loaded',
    exe: path.basename(String(process.argv[1] || process.argv[0] || '')),
    inbox: INBOX ? mask(INBOX) : null
});
/** One Postmark message: only the test inbox stays as a recipient; Cc and Bcc go; the subject says who it would have gone to (masked). */
function rewriteMessage(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m))
        return { ok: false, why: 'a message the guard could not read' };
    const msg = m;
    // A recipient field in another spelling (cc, TO) could still be read by Postmark: the whole message is refused
    if (Object.keys(msg).some((k) => /^(to|cc|bcc)$/i.test(k) && !['To', 'Cc', 'Bcc'].includes(k)))
        return { ok: false, why: 'a recipient field spelled in a way the guard does not rewrite' };
    const all = ['To', 'Cc', 'Bcc'].flatMap((k) => addresses(msg[k]));
    if (!all.length)
        return { ok: false, why: 'a message with no recipient it could read' };
    if (all.every((a) => a.toLowerCase() === INBOX) && !msg.Cc && !msg.Bcc)
        return { ok: true, message: msg, changed: false };
    const out = { ...msg, To: INBOX };
    delete out.Cc;
    delete out.Bcc;
    if (typeof msg.Subject === 'string')
        out.Subject = `[afb-checks test, would go to ${[...new Set(all.map(mask))].join(', ')}] ${msg.Subject}`;
    return { ok: true, message: out, changed: true, was: all.map(mask) };
}
function rewriteBody(text) {
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        return { ok: false, why: 'a body that is not JSON' };
    }
    const wrapped = json &&
        typeof json === 'object' &&
        !Array.isArray(json) &&
        Array.isArray(json.Messages);
    const list = Array.isArray(json)
        ? json
        : wrapped
            ? json.Messages
            : [json];
    const done = list.map(rewriteMessage);
    for (const d of done)
        if (!d.ok)
            return { ok: false, why: d.why };
    const messages = done.map((d) => (d.ok ? d.message : {}));
    const body = Array.isArray(json)
        ? messages
        : wrapped
            ? { ...json, Messages: messages }
            : messages[0];
    return {
        ok: true,
        body: JSON.stringify(body),
        count: done.length,
        changed: done.filter((d) => d.ok && d.changed).length
    };
}
const refusal = (why) => new Response(JSON.stringify({
    ErrorCode: 300,
    Message: `afb-checks mail guard refused this send: ${why}. Mail from a preview goes only to the test inbox.`
}), { status: 422, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
    globalThis.fetch = async function guardedFetch(input, init) {
        let url;
        try {
            const raw = typeof input === 'object' &&
                input !== null &&
                'url' in input &&
                typeof input.url === 'string'
                ? input.url
                : String(input);
            url = new URL(raw);
        }
        catch {
            // An address the guard cannot read is not sent on: it could be a mail host written in a way it does not know
            record({ event: 'refused', note: 'an address the guard could not read' });
            return refusal('an address the guard could not read');
        }
        if (!POSTMARK.test(url.hostname))
            return realFetch.call(this, input, init);
        const asRequest = typeof input === 'object' && input !== null && 'method' in input ? input : null;
        const method = String((init && init.method) || (asRequest && asRequest.method) || 'GET').toUpperCase();
        // Reading the server's own settings or a message's status sends nothing
        if (method === 'GET' || method === 'HEAD')
            return realFetch.call(this, input, init);
        const key = url.pathname.replace(/\/+$/, '').toLowerCase();
        if (!INBOX) {
            record({ event: 'refused', note: 'no test inbox was given to the guard' });
            return refusal('the guard has no test inbox');
        }
        if (method !== 'POST' || !SEND_PATHS.has(key)) {
            record({
                event: 'refused',
                note: `${method} ${url.pathname} is not a send the guard can rewrite`
            });
            return refusal(`${method} ${url.pathname} is not a send the guard can rewrite`);
        }
        let text = null;
        try {
            if (init && init.body !== undefined && init.body !== null)
                text = typeof init.body === 'string' ? init.body : null;
            else if (asRequest && typeof asRequest.clone === 'function')
                text = await asRequest.clone().text();
        }
        catch {
            text = null;
        }
        if (typeof text !== 'string') {
            record({ event: 'refused', note: 'the body was not plain text the guard could read' });
            return refusal('the body was not plain text');
        }
        const r = rewriteBody(text);
        if (!r.ok) {
            record({ event: 'refused', note: r.why });
            return refusal(r.why);
        }
        record({
            event: 'sent',
            note: `${r.count} message(s) to the test inbox, ${r.changed} rewritten`,
            count: r.count,
            rewritten: r.changed
        });
        const headers = new Headers((init && init.headers) || (asRequest && asRequest.headers) || {});
        headers.delete('content-length');
        return realFetch.call(this, url.toString(), { method: 'POST', headers, body: r.body });
    };
}
// The tool counts the guard as loaded only when a process that has it listens on the preview's port, so a launcher (yarn, cross-env) or another runtime cannot stand in for the app
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
    this.once('listening', () => {
        const a = this.address();
        if (a && typeof a === 'object')
            record({ event: 'listening', port: a.port });
    });
    return realListen.apply(this, args);
};
// Another way into Postmark that cannot be rewritten (node:http, node:https) is refused outright
const hostOf = (name, a) => {
    try {
        if (typeof a === 'string')
            return new URL(a.startsWith('//') ? `${name}:${a}` : a).hostname;
        if (a instanceof URL)
            return a.hostname;
        if (a && typeof a === 'object') {
            const o = a;
            return String(o.hostname || String(o.host || '').split(':')[0] || '');
        }
        return '';
    }
    catch {
        return '';
    }
};
for (const [name, mod] of [
    ['http', http],
    ['https', https]
]) {
    for (const fn of ['request', 'get']) {
        const real = mod[fn];
        mod[fn] = function guarded(...args) {
            if (POSTMARK.test(hostOf(name, args[0]))) {
                record({ event: 'refused', note: `node:${name} ${fn} to a mail host` });
                throw new Error('afb-checks mail guard refused a direct request to a mail host. Mail from a preview goes only to the test inbox, through fetch.');
            }
            return real.apply(this, args);
        };
    }
}
