// THE SEALED STORE: AES-256-GCM WITH A KEY THAT LIVES IN THE BRIDGE HOME, NEVER INSIDE THE CHECKS FOLDER, A RUN, A COPY OR A PATH A PREVIEW ENV NAMES.
// seal() binds a text (`aad`, for example the registration org/NAME) into the seal without storing it, so a sealed file opens only for the same text and a copy made for
// another registration fails. The blob is iv (12 bytes) | tag (16 bytes) | ciphertext. Nothing here ever prints or returns a key.
// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { configDir } from '../tokenStore.js';
// -- CONSTANTS -- //
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// -- FUNCTIONS -- //
/** The key file sits beside the token store in the bridge home, one level above the checks folder. */
export const sealKeyFile = () => join(configDir(), 'checks.key');
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Limits the key file to the current user on Windows (icacls on this one file only; the folder and its inheritance are left alone). Best effort. */
function lockDownFile(file) {
    try {
        if (process.platform === 'win32') {
            const user = process.env.USERNAME;
            if (!user)
                return;
            execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 10_000
            });
        }
        else
            chmodSync(file, 0o600);
    }
    catch {
        /* Not fatal: the key is still outside every folder an agent or a check works in */
    }
}
/**
 * The key. Several processes may start at once on a machine that has none yet: the file is made exclusively (the first one wins) and a key that is
 * still being written is waited for. A file that stays the wrong size is damaged and named, never replaced.
 */
function key() {
    const file = sealKeyFile();
    for (let i = 0; i < 80; i++) {
        if (!existsSync(file)) {
            mkdirSync(configDir(), { recursive: true, mode: 0o700 });
            try {
                writeFileSync(file, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
                lockDownFile(file);
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
            }
        }
        let k = null;
        try {
            k = readFileSync(file);
        }
        catch {
            /* Gone again or being written: wait */
        }
        if (k && k.length === KEY_BYTES)
            return k;
        nap(25);
    }
    throw new Error(`The sealing key file (checks.key in the bridge home) is damaged. Nothing sealed with it can be opened; remove the file and import the secrets again.`);
}
/** Seals `plaintext` for `aad`. */
export function seal(aad, plaintext) {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', key(), iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
}
/** Opens a blob made by seal() for the same `aad`. Throws one plain sentence when the blob is damaged or was made for another text. */
export function unseal(aad, blob) {
    const b = Buffer.from(blob);
    if (b.length < IV_BYTES + TAG_BYTES)
        throw new Error('The sealed data is too short to be valid.');
    try {
        const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, IV_BYTES));
        d.setAAD(Buffer.from(aad, 'utf8'));
        d.setAuthTag(b.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([d.update(b.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
    }
    catch {
        throw new Error('The sealed data is damaged or was sealed for something else.');
    }
}
