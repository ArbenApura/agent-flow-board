// FILE STORAGE ADAPTERS: DISK AND MEMORY, AND ANY S3 COMPATIBLE SERVICE (MINIO, AWS S3, ANY OTHER)
// Files are served only through short lived signed URLs, never by a public path (SPEC 6).

// -- DEP-MODULES -- //
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { AwsClient } from 'aws4fetch';

// -- TYPES -- //

export interface Storage {
	readonly kind: 'disk' | 'memory' | 's3';
	put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	delete(key: string): Promise<void>;
	/** A URL that works for `ttlSeconds` and then stops. The base is the public address of this app. */
	signedUrl(baseUrl: string, key: string, ttlSeconds: number): Promise<string>;
}

// -- FUNCTIONS -- //

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
