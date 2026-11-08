// A THROWAWAY DATABASE FOR ONE RUN: A NEW POSTGRES CONTAINER WITH ITS OWN NAME, ITS OWN VOLUME AND ITS OWN PORT. Docker is opt in (`--database tool`).
// Nothing here can reach the container or the volume that holds a person's own database on port 5433: the port is refused, and every docker command
// is checked before it runs so that it can only name a container that starts with `afb-checks-`.
// -- DEP-MODULES -- //
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
// -- MODULES -- //
import { FORBIDDEN_PORTS } from './guardrails.js';
// -- CONSTANTS -- //
/** The ports a check never binds or publishes: the dev server, the build preview and the local PostgreSQL. */
const NEVER_PORTS = FORBIDDEN_PORTS;
/** The local PostgreSQL of the person. No container of ours ever publishes on it. */
const PERSON_DB_PORT = 5433;
/** Every container this tool makes or removes starts with this. */
export const CONTAINER_PREFIX = 'afb-checks-';
const IMAGE = 'postgres:16-alpine';
const DOCKER_COMMANDS = new Set(['version', 'run', 'rm', 'exec', 'inspect', 'logs']);
// -- FUNCTIONS -- //
/** Runs the real docker program. Never throws: a program that cannot start is a status of -1. */
const realDocker = (args) => new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err
            ? typeof err.code === 'number'
                ? err.code
                : -1
            : 0;
        resolve({ status: code, stdout: String(stdout), stderr: String(stderr) });
    });
});
/**
 * Refuses any docker command whose target is not ours. `run` must name its container with --name afb-checks-..., and `rm`, `exec`, `inspect` and `logs`
 * may only name containers that start with afb-checks-. `-v` is a flag of `rm` here (remove the volumes of that container), and `run` never gets a
 * host path or a named volume to mount, so the volume it makes is its own anonymous one.
 */
export function checkDockerArgs(args) {
    const [cmd, ...rest] = args;
    if (!cmd || !DOCKER_COMMANDS.has(cmd))
        throw new Error('That docker command is not one the check tool runs.');
    if (cmd === 'version')
        return;
    if (cmd === 'run') {
        const i = rest.indexOf('--name');
        const name = i >= 0 ? rest[i + 1] : undefined;
        if (!name || !name.startsWith(CONTAINER_PREFIX))
            throw new Error(`The check tool only starts containers named ${CONTAINER_PREFIX}...`);
        if (rest.some((a) => a === '-v' || a === '--volume' || a === '--mount'))
            throw new Error('The check tool never mounts a volume or folder into a container.');
        const p = rest.indexOf('-p');
        const publish = p >= 0 ? (rest[p + 1] ?? '').split(':') : [];
        const hostPort = Number(publish.length === 3 ? publish[1] : publish[0]);
        if (NEVER_PORTS.has(hostPort))
            throw new Error('That port belongs to a dev server or to the person’s own database; the check tool never uses it.');
        return;
    }
    // rm, exec, inspect, logs: a flag, a command word after the container, or the container name
    const names = cmd === 'exec'
        ? [rest.find((a) => !a.startsWith('-'))]
        : rest.filter((a) => !a.startsWith('-'));
    if (!names.length || names.some((n) => !n || !n.startsWith(CONTAINER_PREFIX)))
        throw new Error(`The check tool only touches containers named ${CONTAINER_PREFIX}...`);
}
async function guarded(docker, args) {
    checkDockerArgs(args);
    return docker(args);
}
/** Binds 127.0.0.1:0, reads the port and closes it. Never returns a forbidden port or the person's database port. */
export async function freePort() {
    for (let i = 0; i < 25; i++) {
        const port = await new Promise((resolve, reject) => {
            const s = createServer();
            s.once('error', reject);
            s.listen(0, '127.0.0.1', () => {
                const addr = s.address();
                s.close(() => addr && typeof addr === 'object'
                    ? resolve(addr.port)
                    : reject(new Error('No port was given.')));
            });
        });
        if (!NEVER_PORTS.has(port))
            return port;
    }
    throw new Error('No free port was found that is allowed.');
}
/** Removes ONE container of ours and its volumes, by its exact name. Never throws. */
export async function removeContainer(name, docker = realDocker) {
    try {
        await guarded(docker, ['rm', '-f', '-v', name]);
    }
    catch {
        /* Not ours, already gone, or Docker is not running: nothing to remove */
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Starts a new postgres container for this run and registers its removal on the scope. When `runtimeRole` is given the database also gets that login role,
 * and `databaseUrl` uses it while `ownerUrl` keeps the superuser (migrations need the owner).
 */
export async function makeThrowawayDatabase(runId, scope, log, opts = {}) {
    const docker = opts.docker ?? realDocker;
    const version = await docker(['version']);
    if (version.status !== 0)
        throw new Error('--database tool needs Docker, which is not running');
    const port = await (opts.pickPort ?? freePort)();
    if (port === PERSON_DB_PORT || NEVER_PORTS.has(port))
        throw new Error(`Port ${port} is not one the check tool may use for a database.`);
    const name = `${CONTAINER_PREFIX}${runId}`;
    const password = randomBytes(18).toString('hex');
    const args = [
        'run',
        '-d',
        '--name',
        name,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        'POSTGRES_DB=app',
        '-p',
        `127.0.0.1:${port}:5432`,
        IMAGE
    ];
    const started = await guarded(docker, args);
    // Registered at once: a failure from here on still removes what was made
    const dispose = () => removeContainer(name, docker);
    scope.add(`database ${name}`, dispose);
    scope.setInfo?.({ containerName: name });
    if (started.status !== 0)
        throw new Error('The throwaway database could not be started.');
    log(`Throwaway database ${name} started on port ${port}.`);
    await waitReady(docker, name, opts.readyTimeoutMs ?? 60_000);
    const ownerUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/app`;
    if (!opts.runtimeRole)
        return { databaseUrl: ownerUrl, ownerUrl };
    const role = opts.runtimeRole;
    if (!/^[a-z_][a-z0-9_]{0,40}$/.test(role))
        throw new Error('The runtime role is not a plain role name.');
    const rolePassword = randomBytes(18).toString('hex');
    const made = await guarded(docker, [
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        'app',
        '-c',
        `CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`
    ]);
    if (made.status !== 0)
        throw new Error('The runtime role of the throwaway database could not be made.');
    return {
        databaseUrl: `postgresql://${role}:${rolePassword}@127.0.0.1:${port}/app`,
        ownerUrl,
        roleName: role
    };
}
async function waitReady(docker, name, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        // With -h the check only passes when the real server listens, not the temporary one of the first start
        const r = await guarded(docker, [
            'exec',
            name,
            'pg_isready',
            '-U',
            'postgres',
            '-h',
            '127.0.0.1'
        ]);
        if (r.status === 0)
            return;
        await sleep(500);
    }
    throw new Error('The throwaway database did not accept connections in time.');
}
