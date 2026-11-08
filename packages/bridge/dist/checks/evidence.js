// READING WHAT THE SANDBOXED CHECK WROTE: THE CHILD OWNS ITS RUN FOLDER, SO EVERY FILE IN IT IS HOSTILE UNTIL PROVEN OTHERWISE.
// A check can plant a link where the tool expects a picture (shots/01.jpg -> a key file) and the tool, reading it, would upload that key to the board. So a file is
// read only when it is a regular file (not a link, not a hard link), its real path is inside the folder it should be in, it is small enough, and it starts with the
// bytes of its kind. It is opened without following a link where the platform allows it, and the handle is compared with the first look.
// -- DEP-MODULES -- //
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// -- MODULES -- //
import { isInside } from './paths.js';
// -- CONSTANTS -- //
/** A picture over this is not uploaded. */
export const MAX_SHOT_BYTES = 5 * 1024 * 1024;
/** result.json is a short report. */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const JPEG_MAGIC = [0xff, 0xd8, 0xff];
// -- FUNCTIONS -- //
/** True when the bytes start with the magic bytes. */
const startsWith = (buf, magic) => magic.every((b, i) => buf[i] === b);
/** Reads `name` from `dir` only when it is a plain file of the kind expected. Never throws; says why when it refuses. */
export function readPlainFile(dir, name, opts) {
    const file = join(dir, name);
    let st;
    try {
        st = lstatSync(file);
    }
    catch {
        return { refused: 'it is missing' };
    }
    if (st.isSymbolicLink())
        return { refused: 'it is a link' };
    if (!st.isFile())
        return { refused: 'it is not a regular file' };
    if (st.nlink > 1)
        return { refused: 'it has more than one name on disk' };
    if (st.size > opts.maxBytes)
        return { refused: 'it is too big' };
    if (!isInside(dir, file))
        return { refused: 'it is not inside its folder' };
    let fd = null;
    try {
        fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const fst = fstatSync(fd);
        if (!fst.isFile() || fst.size !== st.size || (st.ino && fst.ino !== st.ino))
            return { refused: 'it changed while it was opened' };
        const bytes = Buffer.alloc(fst.size);
        let at = 0;
        while (at < bytes.length) {
            const n = readSync(fd, bytes, at, bytes.length - at, at);
            if (n <= 0)
                break;
            at += n;
        }
        if (at !== bytes.length)
            return { refused: 'it changed while it was read' };
        if (opts.magic && !startsWith(bytes, opts.magic))
            return { refused: 'it is not the kind of file it should be' };
        return { bytes };
    }
    catch {
        return { refused: 'it could not be opened' };
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
/** True when `name` in `dir` is a plain file (what cleanResult keeps). */
export const isPlainFile = (dir, name) => {
    try {
        const st = lstatSync(join(dir, name));
        return st.isFile() && !st.isSymbolicLink();
    }
    catch {
        return false;
    }
};
/**
 * The first link (symbolic link, junction or file with several names) below a folder, or null. Node's permission model checks the path it is given, not where a
 * link leads, so a link inside a folder the child may read or write reaches files outside it (checked on this Node: both a file link and a junction are followed).
 * The folders given to a check are walked before and after the run, and a run that finds a link is refused.
 */
export function findLink(root, maxEntries = 20_000) {
    let seen = 0;
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return null;
        }
        for (const name of names) {
            if (++seen > maxEntries)
                return join(dir, name);
            const full = join(dir, name);
            let st;
            try {
                st = lstatSync(full);
            }
            catch {
                continue;
            }
            if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1))
                return full;
            if (st.isDirectory()) {
                const hit = walk(full);
                if (hit)
                    return hit;
            }
        }
        return null;
    };
    return walk(root);
}
