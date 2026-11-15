// FILE STORAGE ADAPTERS: DISK AND MEMORY, AND ANY S3 COMPATIBLE SERVICE (MINIO, AWS S3, ANY OTHER)
// Files are served only through short lived signed URLs, never by a public path (SPEC 6).

// IMPORTED DEP-MODULES
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';

// -- TYPES -- //

export interface Storage {
	readonly kind: 'disk' | 'memory' | 's3';
	put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Streams `source` into the file and returns the bytes written, so a large file never has to be held whole. A put that fails
	 * or is abandoned leaves nothing at the key (a disk file is written under a .partial name and renamed when it is complete).
	 */
	putStream(key: string, source: AsyncIterable<Uint8Array>, mime: string): Promise<number>;
	/** The file as a stream of chunks, or null when it is not there. */
	getStream(key: string): Promise<AsyncIterable<Uint8Array> | null>;
	/** The size in bytes, or null when the file is not there. */
	size(key: string): Promise<number | null>;
	delete(key: string): Promise<void>;
	/** A URL that works for `ttlSeconds` and then stops. The base is the public address of this app. */
	signedUrl(baseUrl: string, key: string, ttlSeconds: number): Promise<string>;
}

// -- FUNCTIONS -- //

/**
 * Removes the .partial files a killed backup left in a disk folder. A put renames its file when it is complete, so a .partial
 * is never a backup. Only files older than `olderThanMs` go, so a put still running is left alone. Best effort, never throws.
 */
export async function sweepPartialFiles(dir: string, olderThanMs = 3_600_000): Promise<number> {
	let names: string[];
	try {
		names = await readdir(resolve(dir), { recursive: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		// A .partial file of the disk adapter, or the staging folder of an upload that never finished (S3)
		const staging = name.split(/[\\/]/)[0].startsWith('afb-put-');
		if (!name.endsWith('.partial') && !(staging && !/[\\/]/.test(name))) continue;
		const file = join(resolve(dir), name);
		try {
			if (Date.now() - (await stat(file)).mtimeMs > olderThanMs) {
				await rm(file, { recursive: staging, force: true });
				removed++;
			}
		} catch {
			// A file that vanished meanwhile is not a problem
		}
	}
	return removed;
}

/** Refuses a key that could climb out of the storage root or hide behind odd characters. */
export function safeKey(key: string): string {
	const parts = key.split('/');
	const odd = (p: string) =>
		p === '' ||
		p === '.' ||
		p === '..' ||
		[...p].some((ch) => ch === String.fromCharCode(92) || ch.charCodeAt(0) < 32);
	if (parts.some(odd) || key.length > 400) throw new Error('Unsafe storage key');
	return key;
}

const sign = (secret: string, key: string, exp: number) =>
	createHmac('sha256', secret).update(`${key}\n${exp}`).digest('base64url');

/** The signed link the app itself serves (disk and memory adapters). */
export function signedFileUrl(
	baseUrl: string,
	secret: string,
	key: string,
	ttlSeconds: number,
	now = Date.now()
): string {
	const exp = Math.floor(now / 1000) + ttlSeconds;
	return `${baseUrl}/api/v1/files/${safeKey(key).split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sign(secret, key, exp)}`;
}

/** Checks a signed link. Wrong signature, changed key and expired links all fail. */
export function verifySignedFile(
	secret: string,
	key: string,
	exp: number,
	sig: string,
	now = Date.now()
): boolean {
	if (!Number.isFinite(exp) || exp * 1000 < now) return false;
	const want = Buffer.from(sign(secret, key, exp));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got);
}

export function memoryStorage(
	secret: string
): Storage & { files: Map<string, { bytes: Uint8Array; mime: string }> } {
	const files = new Map<string, { bytes: Uint8Array; mime: string }>();
	return {
		kind: 'memory',
		files,
		async put(key, bytes, mime) {
			files.set(safeKey(key), { bytes, mime });
		},
		async get(key) {
			return files.get(safeKey(key))?.bytes ?? null;
		},
		async putStream(key, source, mime) {
			// The memory adapter holds the bytes anyway (it is for tests and tiny setups), so the stream is gathered
			const parts: Buffer[] = [];
			for await (const chunk of source) parts.push(Buffer.from(chunk));
			const bytes = Buffer.concat(parts);
			files.set(safeKey(key), { bytes, mime });
			return bytes.length;
		},
		async getStream(key) {
			const bytes = files.get(safeKey(key))?.bytes;
			if (!bytes) return null;
			return Readable.from([bytes]);
		},
		async size(key) {
			return files.get(safeKey(key))?.bytes.length ?? null;
		},
		async delete(key) {
			files.delete(safeKey(key));
		},
		async signedUrl(baseUrl, key, ttl) {
			return signedFileUrl(baseUrl, secret, key, ttl);
		}
	};
}

export function diskStorage(root: string, secret: string): Storage {
	const base = resolve(root);
	const path = (key: string) => {
		const full = resolve(join(base, normalize(safeKey(key))));
		if (!full.startsWith(base)) throw new Error('Unsafe storage key');
		return full;
	};
	return {
		kind: 'disk',
		async put(key, bytes) {
			const file = path(key);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, bytes);
		},
		async get(key) {
			try {
				return new Uint8Array(await readFile(path(key)));
			} catch {
				return null;
			}
		},
		async putStream(key, source) {
			const file = path(key);
			await mkdir(dirname(file), { recursive: true });
			// Written under a .partial name and renamed when complete, so a crash never leaves a truncated file at the key
			const partial = `${file}.partial`;
			try {
				await pipeline(Readable.from(source), createWriteStream(partial));
				const handle = await open(partial, 'r+');
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
				const written = (await stat(partial)).size;
				await rename(partial, file);
				return written;
			} catch (e) {
				await rm(partial, { force: true });
				throw e;
			}
		},
		async getStream(key) {
			const file = path(key);
			try {
				await stat(file);
			} catch {
				return null;
			}
			return createReadStream(file);
		},
		async size(key) {
			try {
				return (await stat(path(key))).size;
			} catch {
				return null;
			}
		},
		async delete(key) {
			await rm(path(key), { force: true });
		},
		async signedUrl(baseUrl, key, ttl) {
			return signedFileUrl(baseUrl, secret, key, ttl);
		}
	};
}

/** Any S3 compatible service, signed with aws4fetch. */
export function s3Storage(options: {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	/** Where a streamed upload is staged before it is sent. A private folder is made inside it and removed after. */
	stagingDir?: string;
}): Storage {
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: 's3',
		region: options.region ?? 'auto'
	});
	const url = (key: string) =>
		`${options.endpoint.replace(/\/$/, '')}/${options.bucket}/${safeKey(key).split('/').map(encodeURIComponent).join('/')}`;
	return {
		kind: 's3',
		async put(key, bytes, mime) {
			const res = await client.fetch(url(key), {
				method: 'PUT',
				body: bytes as BodyInit,
				headers: { 'content-type': mime }
			});
			if (!res.ok) throw new Error(`Storage refused the file (${res.status})`);
		},
		async get(key) {
			const res = await client.fetch(url(key));
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`Storage could not read the file (${res.status})`);
			return new Uint8Array(await res.arrayBuffer());
		},
		async putStream(key, source, mime) {
			// The source is staged in a private folder first (it is already encrypted when a backup comes through here), so the
			// PUT has a known length and the source is read once. The folder is removed whatever happens
			const base = options.stagingDir ?? tmpdir();
			await mkdir(base, { recursive: true });
			const folder = await mkdtemp(join(base, 'afb-put-'));
			try {
				const staged = join(folder, 'body');
				await pipeline(Readable.from(source), createWriteStream(staged, { mode: 0o600 }));
				const length = (await stat(staged)).size;
				const res = await client.fetch(url(key), {
					method: 'PUT',
					body: Readable.toWeb(createReadStream(staged)) as unknown as BodyInit,
					duplex: 'half',
					headers: {
						'content-type': mime,
						'content-length': String(length),
						'x-amz-content-sha256': 'UNSIGNED-PAYLOAD'
					}
				} as RequestInit);
				if (!res.ok) throw new Error(`Storage refused the file (${res.status})`);
				return length;
			} finally {
				await rm(folder, { recursive: true, force: true });
			}
		},
		async getStream(key) {
			const res = await client.fetch(url(key));
			if (res.status === 404) return null;
			if (!res.ok || !res.body) throw new Error(`Storage could not read the file (${res.status})`);
			return res.body as unknown as AsyncIterable<Uint8Array>;
		},
		async size(key) {
			const res = await client.fetch(url(key), { method: 'HEAD' });
			if (res.status === 404) return null;
			if (!res.ok) throw new Error(`Storage could not read the file (${res.status})`);
			const length = Number(res.headers.get('content-length'));
			return Number.isFinite(length) ? length : null;
		},
		async delete(key) {
			const res = await client.fetch(url(key), { method: 'DELETE' });
			if (!res.ok && res.status !== 404)
				throw new Error(`Storage could not delete the file (${res.status})`);
		},
		async signedUrl(_base, key, ttl) {
			const signed = await client.sign(new Request(`${url(key)}?X-Amz-Expires=${ttl}`), {
				aws: { signQuery: true }
			});
			return signed.url;
		}
	};
}
