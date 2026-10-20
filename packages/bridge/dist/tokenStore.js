// WHERE THE BRIDGE KEEPS ITS TOKEN. THE OS KEYCHAIN WHERE ONE EXISTS, AN ENCRYPTED FILE WHERE NONE DOES (SSH SESSIONS, CONTAINERS)
// Backends: macOS Keychain (security), Linux Secret Service (secret-tool), Windows DPAPI (bound to the signed in user),
// and an AES-256-GCM file with its key in a separate file readable only by its owner.
// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// -- CONSTANTS -- //
const SERVICE = 'agent-flow-board';
// -- FUNCTIONS -- //
/**
 * The name a sign in is stored under: the server host, plus the organisation when one is chosen, so two organisations on one
 * board keep separate sign ins. Without an organisation it is the plain host, as before.
 */
export const accountKey = (server, org) => org ? `${new URL(server).host}/${org}` : new URL(server).host;
export const configDir = () => process.env.AFB_BRIDGE_HOME ?? join(homedir(), '.agent-flow-board');
function ensureDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const has = (cmd, args = ['--version']) => {
    try {
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000 });
        return true;
    }
    catch {
        return false;
    }
};
/** AES-256-GCM in a file. The key sits in its own file with owner only permissions. Better than plain text, weaker than a keychain. */
export function fileStore(dir = configDir()) {
    const keyFile = join(dir, 'key');
    const dataFile = (account) => join(dir, `token-${account.replace(/[^A-Za-z0-9._-]/g, '_')}.enc`);
    const key = () => {
        ensureDir(dir);
        if (!existsSync(keyFile)) {
            writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
            chmodSync(keyFile, 0o600);
        }
        return readFileSync(keyFile);
    };
    return {
        kind: 'file',
        get(account) {
            const f = dataFile(account);
            if (!existsSync(f))
                return null;
            try {
                const raw = readFileSync(f);
                const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
                d.setAuthTag(raw.subarray(12, 28));
                return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
            }
            catch {
                // A changed key or a damaged file means the token cannot be read, so the person signs in again
                return null;
            }
        },
        set(account, secret) {
            const iv = randomBytes(12);
            const c = createCipheriv('aes-256-gcm', key(), iv);
            const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
            writeFileSync(dataFile(account), Buffer.concat([iv, c.getAuthTag(), enc]), { mode: 0o600 });
        },
        delete(account) {
            rmSync(dataFile(account), { force: true });
        }
    };
}
function macStore() {
    return {
        kind: 'macos',
        get(account) {
            try {
                return (execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim() || null);
            }
            catch {
                return null;
            }
        },
        set(account, secret) {
            execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], { stdio: 'ignore' });
        },
        delete(account) {
            try {
                execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {
                    stdio: 'ignore'
                });
            }
            catch {
                /* Nothing stored */
            }
        }
    };
}
function linuxStore() {
    return {
        kind: 'linux',
        get(account) {
            try {
                return (execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore']
                }).trim() || null);
            }
            catch {
                return null;
            }
        },
        set(account, secret) {
            execFileSync('secret-tool', ['store', '--label', SERVICE, 'service', SERVICE, 'account', account], { input: secret, stdio: ['pipe', 'ignore', 'ignore'] });
        },
        delete(account) {
            try {
                execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', account], {
                    stdio: 'ignore'
                });
            }
            catch {
                /* Nothing stored */
            }
        }
    };
}
/** Windows keeps the secret as a DPAPI blob, which only the same user on the same machine can open. */
function windowsStore(dir = configDir()) {
    const file = (account) => join(dir, `token-${account.replace(/[^A-Za-z0-9._-]/g, '_')}.dpapi`);
    const ps = (script, input) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return {
        kind: 'windows',
        get(account) {
            if (!existsSync(file(account)))
                return null;
            try {
                const out = ps(`$s = ConvertTo-SecureString (Get-Content -Raw -LiteralPath '${file(account)}'); [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`);
                return out || null;
            }
            catch {
                return null;
            }
        },
        set(account, secret) {
            ensureDir(dir);
            const blob = ps('ConvertFrom-SecureString (ConvertTo-SecureString -String ([Console]::In.ReadLine()) -AsPlainText -Force)', secret + '\n');
            writeFileSync(file(account), blob, { mode: 0o600 });
        },
        delete(account) {
            rmSync(file(account), { force: true });
        }
    };
}
/** Picks the best store for this machine. AFB_BRIDGE_STORE=file forces the encrypted file (SSH, containers). */
export function pickStore() {
    const forced = process.env.AFB_BRIDGE_STORE;
    if (forced === 'file')
        return fileStore();
    if (process.platform === 'darwin' && has('security', ['help']))
        return macStore();
    if (process.platform === 'win32' && has('powershell', ['-NoProfile', '-Command', 'exit 0']))
        return windowsStore();
    // No display or session bus (SSH) means the Secret Service is not usable, so the file is used
    if (process.platform === 'linux' &&
        !process.env.SSH_CONNECTION &&
        process.env.DBUS_SESSION_BUS_ADDRESS &&
        has('secret-tool'))
        return linuxStore();
    return fileStore();
}
export { windowsStore };
