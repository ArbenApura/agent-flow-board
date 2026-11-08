// THE DATABASE RULE OF A PREVIEW ENVIRONMENT THAT ADOPTED THE REPO'S OWN .env (STEP 3.7). It FAILS THE RUN, it does not strip. Every variable that is named like a database, and
// every value that is a URL or host:port, is parsed after ${VAR} expansion, URL-decoding and case-folding. Then:
//   1. a loopback host (localhost, 127.x, ::1, 0.0.0.0, host.docker.internal and its kin, in any spelling) on port 5433, 5180 or 5190 is refused, whatever the variable is called
//      (5433 is the local Docker PostgreSQL with real data; 5180 and 5190 are the person's servers). The port is the URL port, or the elided default completed from a sibling
//      *_PORT / PGPORT variable or a ?port= parameter;
//   2. a database or Supabase host is allowed only when it is the sealed test project's host or the run's own throwaway database; anything else fails the run.
// Every sentence names the VARIABLE and never its value.
// -- CONSTANTS -- //
/** Ports a check never reaches: the person's dev server, the build preview and the local Docker PostgreSQL. Same set as guardrails.ts, kept here so this file imports nothing. */
const FORBIDDEN = new Set([5180, 5190, 5433]);
/** Name tokens that make a variable a database setting (split on anything that is not a letter or digit). */
const DB_TOKENS = new Set([
    'DB',
    'PG',
    'SQL',
    'SUPABASE',
    'NEON',
    'TURSO',
    'LIBSQL',
    'POSTGRES',
    'POSTGRESQL',
    'MYSQL',
    'MARIADB',
    'MONGO',
    'MONGODB',
    'REDIS',
    'DATABASE'
]);
/** A name that holds one of these as a substring (DATABASEURL, PGHOST, POSTGRESQL_URL) is a database setting too. */
const DB_SUBSTRING = /DATABASE|POSTGRES|MYSQL|MONGO|REDIS|^PG(HOST|PORT|HOSTADDR|DATABASE|SERVICE)/;
const HOST_NAME = /(HOST|HOSTNAME|HOSTADDR|ADDR|ADDRESS|SERVER|ENDPOINT)$/;
const PORT_NAME = /(^|[^A-Z0-9])PORT$|^PGPORT$/;
const DB_SCHEME = /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|libsql|sqlserver|mssql|cockroachdb):/;
/** Hosted database and Supabase domains: a value that names one is a database host whatever the variable is called. */
const DB_HOST_SUFFIX = /(^|\.)(supabase\.(co|com|in)|neon\.tech|planetscale\.com|psdb\.cloud|rds\.amazonaws\.com|database\.azure\.com|cockroachlabs\.cloud|mongodb\.net|upstash\.io|redislabs\.com|elephantsql\.com|aivencloud\.com|turso\.io)$/;
const LOOPBACK_NAMES = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'host.docker.internal',
    'gateway.docker.internal',
    'kubernetes.docker.internal',
    'host.containers.internal',
    'host.lima.internal',
    'host.internal'
]);
// -- FUNCTIONS -- //
/** `${NAME}`, `${NAME:-default}` and `${NAME-default}` filled from the same environment (names compared without case). Unknown names become empty. Nested up to 5 levels. */
export function expandRefs(value, env, depth = 0) {
    if (depth > 5 || !value.includes('${'))
        return value;
    const upper = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
    const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_all, name, fallback) => {
        const v = upper.get(name.toUpperCase());
        return v !== undefined && v !== '' ? v : (fallback ?? '');
    });
    return out === value ? out : expandRefs(out, env, depth + 1);
}
/** Percent-decoding up to three rounds (a doubly encoded value is still read). A broken escape stops the decoding and keeps what was read. */
function decodeRounds(value) {
    const seen = [value];
    let cur = value;
    for (let i = 0; i < 3; i++) {
        let next;
        try {
            next = decodeURIComponent(cur);
        }
        catch {
            break;
        }
        if (next === cur)
            break;
        seen.push(next);
        cur = next;
    }
    return seen;
}
/** The host with its spelling folded: lower case, no brackets, no trailing dot, no zone id, and number-like IPv4 spellings (2130706433, 0x7f.1, 127.1) as dotted quads. */
export function normalizeHost(raw) {
    let h = raw.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']'))
        h = h.slice(1, -1);
    h = h
        .replace(/%25.*$/, '')
        .replace(/%.*$/, '')
        .replace(/\.+$/, '');
    if (/^[0-9a-fx.]+$/.test(h) && /[0-9]/.test(h) && !h.includes(':')) {
        try {
            return new URL(`http://${h}`).hostname;
        }
        catch {
            return h;
        }
    }
    return h;
}
/** True when the host reaches this machine: localhost and its kin, 127.0.0.0/8, 0.0.0.0, the IPv6 loopback and unspecified addresses (also as IPv4-mapped), the Docker host names. */
export function isLoopbackHost(raw) {
    const h = normalizeHost(raw);
    if (!h)
        return false;
    if (LOOPBACK_NAMES.has(h) || h.endsWith('.localhost'))
        return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(h) || /^0\.\d+\.\d+\.\d+$/.test(h))
        return true;
    if (h.includes(':')) {
        // The URL parser gives the one canonical spelling of an IPv6 address (::1, ::, ::ffff:7f00:1)
        let canon;
        try {
            canon = new URL(`http://[${h}]`).hostname.slice(1, -1);
        }
        catch {
            return false;
        }
        if (canon === '::1' || canon === '::')
            return true;
        const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(canon);
        if (mapped) {
            const hi = parseInt(mapped[1] ?? '1', 16);
            return hi >> 8 === 127 || hi === 0;
        }
    }
    return false;
}
/** The host and port of one authority part, `user:pw@host:port` or `[::1]:port` or `host`. */
function splitAuthority(part) {
    const at = part.lastIndexOf('@');
    const hp = at >= 0 ? part.slice(at + 1) : part;
    if (hp.startsWith('[')) {
        const end = hp.indexOf(']');
        const host = end >= 0 ? hp.slice(0, end + 1) : hp;
        const port = /^:(\d{1,5})$/.exec(end >= 0 ? hp.slice(end + 1) : '');
        return { host, port: port?.[1] ? Number(port[1]) : null };
    }
    const colon = hp.lastIndexOf(':');
    if (colon >= 0 && /^\d{1,5}$/.test(hp.slice(colon + 1)) && hp.indexOf(':') === colon)
        return { host: hp.slice(0, colon), port: Number(hp.slice(colon + 1)) };
    return { host: hp, port: null };
}
/** Every host the value names, with the ports it states itself. `schemeOnly` is true for a URL or a connection string, false for a bare host:port. */
function hostsOf(text) {
    const out = [];
    const url = /^([a-z][a-z0-9+.-]*):\/\/([^\s]*)$/.exec(text);
    if (url) {
        const dbScheme = DB_SCHEME.test(`${url[1]}:`);
        const rest = url[2] ?? '';
        const cut = rest.search(/[/?#]/);
        const authority = cut >= 0 ? rest.slice(0, cut) : rest;
        const query = rest.indexOf('?') >= 0 ? (rest.slice(rest.indexOf('?') + 1).split('#')[0] ?? '') : '';
        const params = new URLSearchParams(query);
        const qPort = params.get('port');
        const qPorts = qPort && /^\d{1,5}$/.test(qPort) ? [Number(qPort)] : [];
        // The host list is what follows the last @ (a password may hold a comma): mongodb://h1:1,h2:2
        const at = authority.lastIndexOf('@');
        const parts = authority.slice(at + 1).split(',');
        for (const part of parts) {
            if (!part)
                continue;
            const { host, port } = splitAuthority(part);
            if (host)
                out.push({
                    host,
                    ports: port !== null ? [port] : qPorts,
                    portKnown: port !== null || qPorts.length > 0,
                    dbScheme,
                    urlLike: true
                });
        }
        for (const key of ['host', 'hostaddr', 'sslhost']) {
            for (const h of (params.get(key) ?? '').split(',').filter(Boolean))
                out.push({ host: h, ports: qPorts, portKnown: qPorts.length > 0, dbScheme, urlLike: true });
        }
        return out;
    }
    // A libpq key/value connection string: `host=localhost port=5433 dbname=app`, a value may be single quoted, host and port may be lists
    const pairs = [...text.matchAll(/(?:^|\s)(host|hostaddr|port)\s*=\s*('(?:[^'\\]|\\.)*'|\S*)/gi)];
    if (pairs.length) {
        const valuesOf = (key) => pairs
            .filter((m) => m[1]?.toLowerCase() === key)
            .flatMap((m) => (m[2] ?? '').replace(/^'|'$/g, '').split(','))
            .map((v) => v.trim())
            .filter(Boolean);
        const hosts = [...valuesOf('host'), ...valuesOf('hostaddr')];
        const ports = valuesOf('port')
            .filter((p) => /^\d{1,5}$/.test(p))
            .map(Number);
        for (const host of hosts)
            out.push({ host, ports, portKnown: ports.length > 0, dbScheme: true, urlLike: true });
        if (out.length)
            return out;
    }
    // A bare host:port, with or without a path
    const bare = /^(\[[0-9a-f:.%a-z]+\]|[a-z0-9.-]+):(\d{1,5})(?:[/?#].*)?$/.exec(text);
    if (bare && bare[1] && bare[2]) {
        out.push({
            host: bare[1],
            ports: [Number(bare[2])],
            portKnown: true,
            dbScheme: false,
            urlLike: false
        });
    }
    return out;
}
const isDbName = (name) => {
    const upper = name.toUpperCase();
    return DB_SUBSTRING.test(upper) || upper.split(/[^A-Z0-9]+/).some((t) => DB_TOKENS.has(t));
};
/** The ports that sibling variables give to a database variable whose own port was elided. */
function siblingPorts(name, env) {
    const upper = name.toUpperCase();
    const prefix = upper.replace(/[_]?(URL|URI|DSN|CONNECTION_STRING|CONNECTION|HOSTNAME|HOSTADDR|HOST|ADDRESS|ADDR|SERVER|ENDPOINT)$/, '');
    const wanted = new Set([
        'PGPORT',
        prefix ? `${prefix}_PORT` : '',
        prefix ? `${prefix}PORT` : '',
        'DB_PORT',
        'DATABASE_PORT',
        'POSTGRES_PORT',
        'POSTGRESQL_PORT',
        'MYSQL_PORT',
        'REDIS_PORT',
        'MONGO_PORT'
    ].filter(Boolean));
    const out = [];
    for (const [k, v] of env)
        if (wanted.has(k) && /^\d{1,5}$/.test(v.trim()))
            out.push({ var: k, port: Number(v.trim()) });
    return out;
}
/** The throwaway database written as host or host:port. */
function allowedBy(host, ports, allowed) {
    if (!allowed)
        return false;
    const probe = hostsOf(`x://${allowed}`)[0] ?? { host: allowed, ports: [] };
    const a = normalizeHost(probe.host);
    const h = normalizeHost(host);
    const sameHost = a === h || (isLoopbackHost(a) && isLoopbackHost(h));
    if (!sameHost)
        return false;
    return (probe.ports.length === 0 || ports.length === 0 || ports.some((p) => probe.ports.includes(p)));
}
/**
 * Every problem of the database and address settings in `env`, as plain sentences that name VARIABLES only. An empty list means the environment may be used.
 * `env` is the adopted environment (plus anything else the start step is given); the run's own throwaway database and the sealed test host are the only databases allowed.
 */
export function databaseProblems(env, { testHost, throwawayHost } = {}) {
    const problems = [];
    const add = (s) => {
        if (!problems.includes(s))
            problems.push(s);
    };
    // Expanded copy of the whole environment, names folded to upper case (a Windows environment has no case)
    const expanded = new Map();
    for (const [k, v] of Object.entries(env))
        expanded.set(k.toUpperCase(), expandRefs(String(v), env));
    for (const name of Object.keys(env)) {
        const upper = name.toUpperCase();
        const dbNamed = isDbName(name);
        const folded = (expanded.get(upper) ?? '').trim();
        if (!folded)
            continue;
        // A database port variable on its own
        if (dbNamed &&
            PORT_NAME.test(upper) &&
            /^\d{1,5}$/.test(folded) &&
            FORBIDDEN.has(Number(folded))) {
            add(forbiddenSentence(name, Number(folded)));
            continue;
        }
        const spellings = decodeRounds(folded).map((s) => s.toLowerCase());
        const candidates = [];
        for (const s of spellings) {
            for (const h of hostsOf(s))
                candidates.push({ ...h, spelling: s });
            // A database host variable holds a bare host name (PGHOST, DB_HOST)
            if (dbNamed &&
                HOST_NAME.test(upper) &&
                !s.includes('://') &&
                !/^\[?[a-z0-9.:-]+\]?:\d{1,5}(?:[/?#].*)?$/.test(s))
                candidates.push({
                    host: s,
                    ports: [],
                    portKnown: false,
                    dbScheme: false,
                    urlLike: false,
                    spelling: s
                });
        }
        for (const c0 of candidates) {
            // A host written with percent escapes (local%68ost) is read as it will be resolved
            const c = { ...c0, host: decodeRounds(c0.host).at(-1) ?? c0.host };
            if (c.host.length === 0)
                continue;
            let ports = c.ports;
            if (!c.portKnown) {
                const sib = siblingPorts(name, expanded);
                ports = sib.map((s) => s.port);
            }
            const loop = isLoopbackHost(c.host);
            const dbish = dbNamed || c.dbScheme || DB_HOST_SUFFIX.test(normalizeHost(c.host)) || /^pg/.test(upper);
            const bad = ports.find((p) => FORBIDDEN.has(p));
            if (loop && bad !== undefined) {
                add(forbiddenSentence(name, bad));
                continue;
            }
            if (!dbish)
                continue;
            if (loop) {
                if (!allowedBy(c.host, ports, throwawayHost))
                    add(`${name} names a database on this machine that this run did not make, so the run does not start. Remove it; the run uses its own throwaway database.`);
                continue;
            }
            const h = normalizeHost(c.host);
            const ok = (testHost && h === normalizeHost(testHost)) || allowedBy(c.host, ports, throwawayHost);
            if (!ok)
                add(`${name} names a database or Supabase host that is not this registration's sealed test project or the run's own throwaway database, so the run does not start.`);
        }
    }
    return problems;
}
const forbiddenSentence = (name, port) => `${name} points at port ${port} on this machine, which a check never uses (the local database that holds real data, or a server the person runs), so the run does not start.`;
