// THE NAMES A SEALED VALUE MAY HAVE AND MAY BE GIVEN TO. PURE CONSTANTS AND PREDICATES (NO FILES, NO KEYS), SO THE RECIPE VALIDATOR, THE SEALED STORE AND THE
// ENV RULES SHARE ONE SET. Ported verbatim from the old tool's lib/secrets.mjs.
// -- CONSTANTS -- //
/** The setting names a sealed value may be given to (and the names that may be imported): Supabase's own and the app's auth secret. NODE_OPTIONS, PATH and the like can never be one. */
export const SUPABASE_KEY = /^((NEXT_PUBLIC_|PUBLIC_|VITE_)?SUPABASE_(URL|ANON_KEY|PUBLISHABLE_KEY)|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|ATTENDEE_AUTH_SECRET)$/;
/** The mail settings: the app's Postmark token, From address and stream. A preview given them can send mail, so it only runs behind the mail guard. */
export const MAIL_ENV_KEY = /^POSTMARK_(SERVER_TOKEN|FROM_EMAIL|MESSAGE_STREAM)$/;
export const SECRET_ENV_KEY = new RegExp(`(?:${SUPABASE_KEY.source})|(?:${MAIL_ENV_KEY.source})`);
/** Names that hold a key which bypasses row-level security, whatever the value looks like. */
export const SERVICE_NAME = /(SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY)$/;
/** A setting a browser bundle may carry: a service key never goes into one. */
export const CLIENT_NAME = /^(NEXT_PUBLIC_|PUBLIC_|VITE_)/;
/** In a recipe: {secret:NAME}. */
export const SECRET_PLACEHOLDER = /^\{secret:([A-Z0-9_]{2,60})\}$/;
export const URL_KEY = /SUPABASE_URL$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,200}\.[A-Za-z]{2,24}$/;
/** The whole mail set by name: a variable of any of these providers is a mail setting. SES must be a whole word (SESSION_SECRET is not mail). */
export const MAIL_SET_NAME = /(MAIL|SMTP|POSTMARK|SENDGRID|MAILGUN|RESEND)|(^|_)SES(_|$)/i;
// -- FUNCTIONS -- //
export const isMailKey = (name) => MAIL_ENV_KEY.test(String(name));
/** Every plain sentence about how a recipe env setting `key` uses the placeholder `value`, or an empty list. Names only, never the value. */
export function placeholderProblems(key, value) {
    const m = SECRET_PLACEHOLDER.exec(value);
    if (m && m[1] !== undefined && SERVICE_NAME.test(m[1]) && CLIENT_NAME.test(key))
        return [`The recipe gives ${key}, which a browser bundle carries, the service key ${m[1]}.`];
    if (m &&
        m[1] !== undefined &&
        SECRET_ENV_KEY.test(m[1]) &&
        SECRET_ENV_KEY.test(key) &&
        (isMailKey(key) !== isMailKey(m[1]) || (isMailKey(key) && key !== m[1])))
        return [
            `The recipe gives ${key} the sealed value ${m[1]}: a mail setting takes only the sealed value of its own name (another kind of value is never swapped in).`
        ];
    if (!m || m[1] === undefined || !SECRET_ENV_KEY.test(m[1]) || !SECRET_ENV_KEY.test(key))
        return [
            `The recipe gives ${key} a sealed value that is not written as {secret:NAME}, or names a key that only a Supabase setting or a mail setting (POSTMARK_SERVER_TOKEN, POSTMARK_FROM_EMAIL, POSTMARK_MESSAGE_STREAM) may take.`
        ];
    return [];
}
