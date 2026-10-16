// THE BACKUP CONTAINER: FRAMES OF DATA, COMPRESSED, THEN ENCRYPTED IN BLOCKS THAT CANNOT BE REORDERED OR CUT SHORT (SPEC 8)
// Layout: magic, version, salt, then blocks of [length][nonce][ciphertext and tag]. Each block's AAD is its index and whether
// it is the last one, so a changed, swapped, dropped or truncated block fails to decrypt. The key comes from BACKUP_KEY.

// -- DEP-MODULES -- //
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

// -- TYPES -- //

export type Frame =
	| { type: 'meta'; json: unknown }
	| { type: 'table'; json: unknown }
	| { type: 'file'; json: unknown; bytes: Uint8Array };

// -- CONSTANTS -- //

const MAGIC = Buffer.from('AFBBAK1\n');
const VERSION = 1;
const BLOCK = 1024 * 1024;
const FRAME_META = 1;
const FRAME_TABLE = 2;
const FRAME_FILE = 3;

export class BackupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BackupError';
	}
}

// -- FUNCTIONS -- //

function deriveKey(secret: string, salt: Buffer): Buffer {
	if (secret.length < 32) throw new BackupError('BACKUP_KEY must be at least 32 characters.');
	return Buffer.from(hkdfSync('sha256', secret, salt, 'afb-backup-v1', 32));
}

/** Frames to plain bytes: [type][length][payload], and a file frame carries its JSON header then its bytes. */
function frameBytes(frames: Frame[]): Buffer {
	const parts: Buffer[] = [];
	for (const f of frames) {
		const json = Buffer.from(JSON.stringify(f.json));
		const body =
			f.type === 'file'
				? Buffer.concat([lengthPrefix(json.length), json, Buffer.from(f.bytes)])
				: json;
		const type = f.type === 'meta' ? FRAME_META : f.type === 'table' ? FRAME_TABLE : FRAME_FILE;
		parts.push(Buffer.from([type]), lengthPrefix(body.length), body);
	}
	return Buffer.concat(parts);
}

function lengthPrefix(n: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
}

/** Compresses and encrypts frames into one archive. */
export function writeArchive(frames: Frame[], secret: string): Buffer {
	const salt = randomBytes(16);
	const key = deriveKey(secret, salt);
	const noncePrefix = randomBytes(4);
	const packed = gzipSync(frameBytes(frames));
	const blocks: Buffer[] = [];
	const count = Math.max(1, Math.ceil(packed.length / BLOCK));
	for (let i = 0; i < count; i++) {
		const last = i === count - 1;
		const plain = packed.subarray(i * BLOCK, (i + 1) * BLOCK);
		const nonce = Buffer.concat([noncePrefix, Buffer.alloc(8)]);
		nonce.writeBigUInt64BE(BigInt(i), 4);
		const cipher = createCipheriv('aes-256-gcm', key, nonce);
		cipher.setAAD(Buffer.from(`${i}:${last ? 1 : 0}`));
		const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		blocks.push(lengthPrefix(enc.length), nonce, enc);
	}
	return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, ...blocks]);
}

/** Decrypts and decompresses an archive back to frames. A wrong key or any change throws a plain error. */
export function readArchive(archive: Uint8Array, secret: string): Frame[] {
	const buf = Buffer.from(archive);
	if (buf.length < MAGIC.length + 17 || !buf.subarray(0, MAGIC.length).equals(MAGIC))
		throw new BackupError('This is not an agent-flow-board backup.');
	if (buf[MAGIC.length] !== VERSION)
		throw new BackupError('This backup was made by a newer version.');
	const salt = buf.subarray(MAGIC.length + 1, MAGIC.length + 17);
	const key = deriveKey(secret, salt);
	const plain: Buffer[] = [];
	let at = MAGIC.length + 17;
	let index = 0;
	let sawLast = false;
	while (at < buf.length) {
		if (sawLast) throw new BackupError('The backup has data after its last block.');
		const len = buf.readUInt32BE(at);
		const nonce = buf.subarray(at + 4, at + 16);
		const enc = buf.subarray(at + 16, at + 16 + len);
		if (enc.length !== len || len < 16) throw new BackupError('The backup is cut short.');
		at += 16 + len;
		const last = at >= buf.length;
		try {
			const d = createDecipheriv('aes-256-gcm', key, nonce);
			d.setAAD(Buffer.from(`${index}:${last ? 1 : 0}`));
			d.setAuthTag(enc.subarray(len - 16));
			plain.push(Buffer.concat([d.update(enc.subarray(0, len - 16)), d.final()]));
		} catch {
			throw new BackupError(
				'The backup could not be decrypted. The key is wrong, or the file was changed or cut short.'
			);
		}
		sawLast = last;
		index++;
	}
	if (!sawLast) throw new BackupError('The backup is cut short.');
	let raw: Buffer;
	try {
		raw = gunzipSync(Buffer.concat(plain));
	} catch {
		throw new BackupError('The backup is damaged.');
	}
	const frames: Frame[] = [];
	let p = 0;
	while (p < raw.length) {
		const type = raw[p];
		const size = raw.readUInt32BE(p + 1);
		const body = raw.subarray(p + 5, p + 5 + size);
		p += 5 + size;
		if (type === FRAME_META) frames.push({ type: 'meta', json: JSON.parse(body.toString()) });
		else if (type === FRAME_TABLE)
			frames.push({ type: 'table', json: JSON.parse(body.toString()) });
		else if (type === FRAME_FILE) {
			const hl = body.readUInt32BE(0);
			frames.push({
				type: 'file',
				json: JSON.parse(body.subarray(4, 4 + hl).toString()),
				bytes: new Uint8Array(body.subarray(4 + hl))
			});
		} else throw new BackupError('The backup holds a part this version does not know.');
	}
	return frames;
}
