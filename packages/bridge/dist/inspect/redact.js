// REDACTION: NOTHING THAT LOOKS LIKE A SECRET, AND NOTHING THE RUN WAS TOLD IS A SECRET, REACHES A LOG, A RESULT OR AN UPLOAD.
// This file imports nothing, so the sandboxed child can load it without touching the token store.
// -- CONSTANTS -- //
/** The shapes of tokens, whatever their value. */
const PATTERNS = [
    /\b(?:afx|afb|afrun)_[A-Za-z0-9._-]{12,}/g, // A board runner or bridge token
    /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}/g, // A Supabase key of the new kind
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // A JWT
    /\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]+/gi
];
/** user:password@host in any address: the password is hidden whatever it is, so a database url in a log never shows it. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;
/** A needle shorter than this is ignored, because removing a 3 letter word would wipe the text. */
const MIN_NEEDLE = 6;
/** Variables whose value is a secret by the look of their name. */
const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|KEY|URL|URI)$/i;
const MIN_ENV_VALUE = 8;
// -- FUNCTIONS -- //
/** Masks what looks like a token, a cookie header or a password inside an address. */
export function redactPatterns(text) {
    let out = String(text);
    for (const p of PATTERNS)
        out = out.replace(p, '[hidden]');
    return out.replace(USERINFO, '$1:[hidden]@');
}
/** Every spelling of a needle that could show up in a log: raw, as in a URL, and as base64 (padded and not). */
function forms(needle) {
    const b64 = Buffer.from(needle, 'utf8').toString('base64');
    return [...new Set([needle, encodeURIComponent(needle), b64, b64.replace(/=+$/, '')])].filter((f) => f.length >= MIN_NEEDLE);
}
/** needles: exact strings (a typed password, a token) to remove wherever they appear, then the token shapes. */
export function redact(text, needles = []) {
    let out = String(text);
    // Longest first, so a needle that contains another is removed whole
    const all = needles
        .filter((n) => typeof n === 'string' && n.length >= MIN_NEEDLE)
        .flatMap(forms)
        .sort((a, b) => b.length - a.length);
    for (const f of all)
        out = out.split(f).join('[hidden]');
    return redactPatterns(out);
}
/** The values of the variables that look like secrets (by name), ready to be used as needles. */
export function needlesFromEnv(env) {
    const out = new Set();
    for (const [name, value] of Object.entries(env)) {
        if (typeof value === 'string' && value.length >= MIN_ENV_VALUE && SECRET_NAME.test(name))
            out.add(value);
    }
    return [...out];
}
