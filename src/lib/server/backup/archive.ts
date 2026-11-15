// THE BACKUP CONTAINER: FRAMES OF DATA, COMPRESSED, THEN ENCRYPTED IN BLOCKS THAT CANNOT BE REORDERED OR CUT SHORT (SPEC 8)
// Layout: magic, version, salt, then blocks of [length][nonce][ciphertext and tag]. Each block's AAD is its index and whether
// it is the last one, so a changed, swapped, dropped or truncated block fails to decrypt. The key comes from BACKUP_KEY.

// IMPORTED DEP-MODULES
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createGunzip, createGzip, gunzipSync, gzipSync } from 'node:zlib';

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
		blocks.push(sealBlock(key, noncePrefix, i, last, packed.subarray(i * BLOCK, (i + 1) * BLOCK)));
	}
	return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, ...blocks]);
}

/** One encrypted block: [length][nonce][ciphertext and tag]. The nonce is the stream's prefix and the block index, the AAD says whether it is the last. */
function sealBlock(
	key: Buffer,
	noncePrefix: Buffer,
	index: number,
	last: boolean,
	plain: Buffer
): Buffer {
	const nonce = Buffer.concat([noncePrefix, Buffer.alloc(8)]);
	nonce.writeBigUInt64BE(BigInt(index), 4);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	cipher.setAAD(Buffer.from(`${index}:${last ? 1 : 0}`));
	const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
	return Buffer.concat([lengthPrefix(enc.length), nonce, enc]);
}

/** The plain bytes of the frames in order, one piece at a time. The layout is the one frameBytes makes, without joining it. */
async function* frameChunks(frames: AsyncIterable<Frame>): AsyncGenerator<Buffer> {
	for await (const f of frames) {
		const json = Buffer.from(JSON.stringify(f.json));
		const type = f.type === 'meta' ? FRAME_META : f.type === 'table' ? FRAME_TABLE : FRAME_FILE;
		if (f.type === 'file') {
			const bytes = Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength);
			yield Buffer.concat([
				Buffer.from([type]),
				lengthPrefix(4 + json.length + bytes.length),
				lengthPrefix(json.length),
				json
			]);
			yield bytes;
		} else yield Buffer.concat([Buffer.from([type]), lengthPrefix(json.length), json]);
	}
}

/**
 * Compresses and encrypts frames into the same archive writeArchive makes, as a stream of pieces, so no whole archive is ever
 * held. A block is sealed only when the next one is known (one block of lookahead), because its AAD says whether it is the last,
 * and the final block is never empty unless the whole archive is. `block` is a test hook.
 */
export async function* writeArchiveStream(
	frames: AsyncIterable<Frame>,
	secret: string,
	block = BLOCK
): AsyncGenerator<Buffer> {
	const salt = randomBytes(16);
	const key = deriveKey(secret, salt);
	const noncePrefix = randomBytes(4);
	yield Buffer.concat([MAGIC, Buffer.from([VERSION]), salt]);
	const source = Readable.from(frameChunks(frames), { highWaterMark: 1 });
	const gzip = createGzip();
	source.on('error', (e) => gzip.destroy(e));
	source.pipe(gzip);
	let held: Buffer | null = null;
	let index = 0;
	let queue: Buffer[] = [];
	let queued = 0;
	try {
		for await (const chunk of gzip) {
			queue.push(chunk);
			queued += chunk.length;
			if (queued < block) continue;
			const all = Buffer.concat(queue);
			let at = 0;
			while (all.length - at >= block) {
				const piece = all.subarray(at, at + block);
				at += block;
				if (held) yield sealBlock(key, noncePrefix, index++, false, held);
				held = piece;
			}
			queue = at < all.length ? [all.subarray(at)] : [];
			queued = all.length - at;
		}
	} finally {
		source.destroy();
		gzip.destroy();
	}
	const rest = Buffer.concat(queue);
	if (rest.length > 0) {
		// The last block's index is the one after the held block
		if (held) yield sealBlock(key, noncePrefix, index, false, held);
		yield sealBlock(key, noncePrefix, index + (held ? 1 : 0), true, rest);
	} else if (held) yield sealBlock(key, noncePrefix, index, true, held);
	else yield sealBlock(key, noncePrefix, 0, true, Buffer.alloc(0));
}

/** Reads a stream of pieces as exact byte counts, joining pieces only when a count is asked for. */
class ByteReader {
	private chunks: Buffer[] = [];
	private len = 0;
	private ended = false;
	private it: AsyncIterator<Uint8Array>;

	constructor(source: AsyncIterable<Uint8Array>) {
		this.it = source[Symbol.asyncIterator]();
	}

	private async pull(): Promise<boolean> {
		if (this.ended) return false;
		const r = await this.it.next();
		if (r.done) {
			this.ended = true;
			return false;
		}
		const b = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
		if (b.length) {
			this.chunks.push(b);
			this.len += b.length;
		}
		return true;
	}

	/** True when at least `n` bytes are available, reading more pieces as needed. */
	async ensure(n: number): Promise<boolean> {
		while (this.len < n && (await this.pull()));
		return this.len >= n;
	}

	async atEnd(): Promise<boolean> {
		return !(await this.ensure(1));
	}

	/** Exactly `n` bytes, or fewer when the source ends first. */
	async take(n: number): Promise<Buffer> {
		await this.ensure(n);
		const want = Math.min(n, this.len);
		const out: Buffer[] = [];
		let need = want;
		while (need > 0) {
			const c = this.chunks[0];
			if (c.length <= need) {
				out.push(c);
				this.chunks.shift();
				need -= c.length;
			} else {
				out.push(c.subarray(0, need));
				this.chunks[0] = c.subarray(need);
				need = 0;
			}
		}
		this.len -= want;
		return out.length === 1 ? out[0] : Buffer.concat(out);
	}

	async close(): Promise<void> {
		await this.it.return?.(undefined);
	}
}

/** The blocks of an archive, decrypted one at a time. A block is the last when nothing follows it. */
async function* openBlocks(input: ByteReader, key: Buffer): AsyncGenerator<Buffer> {
	let index = 0;
	while (!(await input.atEnd())) {
		const lenBytes = await input.take(4);
		if (lenBytes.length < 4) throw new BackupError('The backup is cut short.');
		const len = lenBytes.readUInt32BE(0);
		if (len < 16) throw new BackupError('The backup is cut short.');
		// A damaged length must not make the reader ask for gigabytes
		if (len > BLOCK + 32) throw new BackupError('The backup is damaged.');
		const nonce = await input.take(12);
		const enc = await input.take(len);
		if (nonce.length < 12 || enc.length !== len) throw new BackupError('The backup is cut short.');
		const last = await input.atEnd();
		try {
			const d = createDecipheriv('aes-256-gcm', key, nonce);
			d.setAAD(Buffer.from(`${index}:${last ? 1 : 0}`));
			d.setAuthTag(enc.subarray(len - 16));
			yield Buffer.concat([d.update(enc.subarray(0, len - 16)), d.final()]);
		} catch (e) {
			if (e instanceof BackupError) throw e;
			throw new BackupError(
				'The backup could not be decrypted. The key is wrong, or the file was changed or cut short.'
			);
		}
		index++;
	}
	if (index === 0) throw new BackupError('The backup is cut short.');
}

/** The frames in the decompressed bytes, one at a time. */
async function* parseFrames(raw: ByteReader): AsyncGenerator<Frame> {
	while (!(await raw.atEnd())) {
		const head = await raw.take(5);
		if (head.length < 5) throw new BackupError('The backup is damaged.');
		const type = head[0];
		const size = head.readUInt32BE(1);
		const body = await raw.take(size);
		if (body.length < size) throw new BackupError('The backup is damaged.');
		if (type !== FRAME_META && type !== FRAME_TABLE && type !== FRAME_FILE)
			throw new BackupError('The backup holds a part this version does not know.');
		let frame: Frame;
		try {
			if (type === FRAME_FILE) {
				const hl = body.readUInt32BE(0);
				frame = {
					type: 'file',
					json: JSON.parse(body.subarray(4, 4 + hl).toString()),
					bytes: new Uint8Array(body.buffer, body.byteOffset + 4 + hl, body.length - 4 - hl)
				};
			} else
				frame = {
					type: type === FRAME_META ? 'meta' : 'table',
					json: JSON.parse(body.toString())
				};
		} catch {
			// A frame that was authenticated but cannot be read is damage too, said plainly
			throw new BackupError('The backup is damaged.');
		}
		yield frame;
	}
}

/** A damaged compressed stream is the backup's damage, any other error is passed on as it is. */
function asBackupError(e: unknown): unknown {
	if (e instanceof BackupError) return e;
	const code = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined;
	if (typeof code === 'string' && code.startsWith('Z_'))
		return new BackupError('The backup is damaged.');
	return e;
}

/**
 * Decrypts and decompresses an archive as it arrives and yields its frames one at a time, so a backup of any size is read in
 * flat memory. The same checks as readArchive: the key, every block's place and whether it is the last, and the compressed
 * stream. A wrong key or any change throws a plain BackupError, after frames before the damage may already have been yielded:
 * a caller that must not act on a damaged archive reads it once with inspectArchiveStream first.
 */
export async function* readArchiveStream(
	source: AsyncIterable<Uint8Array>,
	secret: string
): AsyncGenerator<Frame> {
	const input = new ByteReader(source);
	try {
		const head = await input.take(MAGIC.length + 17);
		if (head.length < MAGIC.length + 17 || !head.subarray(0, MAGIC.length).equals(MAGIC))
			throw new BackupError('This is not an Agent Flow Board backup.');
		if (head[MAGIC.length] !== VERSION)
			throw new BackupError('This backup was made by a newer version.');
		const key = deriveKey(secret, head.subarray(MAGIC.length + 1, MAGIC.length + 17));
		const plain = Readable.from(openBlocks(input, key), { highWaterMark: 1 });
		const gunzip = createGunzip();
		plain.on('error', (e) => gunzip.destroy(e));
		plain.pipe(gunzip);
		const raw = new ByteReader(gunzip);
		try {
			yield* parseFrames(raw);
		} catch (e) {
			throw asBackupError(e);
		} finally {
			plain.destroy();
			gunzip.destroy();
			await raw.close().catch(() => undefined);
		}
	} finally {
		await input.close().catch(() => undefined);
	}
}

/** Decrypts and decompresses an archive back to frames. A wrong key or any change throws a plain error. */
export function readArchive(archive: Uint8Array, secret: string): Frame[] {
	const buf = Buffer.from(archive);
	if (buf.length < MAGIC.length + 17 || !buf.subarray(0, MAGIC.length).equals(MAGIC))
		throw new BackupError('This is not an Agent Flow Board backup.');
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
