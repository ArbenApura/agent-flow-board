// THE BROWSER'S CALLS TO THE REST API (THE SAME OPERATIONS THE AGENTS USE). THE SESSION COOKIE IS THE CREDENTIAL.

// -- TYPES -- //
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
		this.name = 'ApiError';
	}
}

// -- FUNCTIONS -- //

/** Calls `/api/v1/orgs/{org}{path}` and returns the parsed JSON, or throws an ApiError with the server's plain message. */
export async function api<T = unknown>(
	org: string,
	path: string,
	init: { method?: string; body?: unknown; key?: string; keepalive?: boolean } = {}
): Promise<T> {
	const res = await fetch(`/api/v1/orgs/${org}${path}`, {
		// A call made while the page closes (a last checkpoint) must outlive it
		...(init.keepalive ? { keepalive: true } : {}),
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
		headers: {
			...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(init.key ? { 'idempotency-key': init.key } : {})
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body)
	});
	let json: unknown = null;
	try {
		json = await res.json();
	} catch {
		/* An empty or non JSON answer */
	}
	if (!res.ok) {
		const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
			?.error;
		throw new ApiError(
			res.status,
			e?.code ?? 'ERROR',
			e?.message ?? 'The server could not do that.',
			e?.details
		);
	}
	return json as T;
}

/** A fresh idempotency key, so a retried click never writes twice. */
export const newKey = () => `ui-${crypto.randomUUID()}`;

/** Sends a file as the raw body, with its name and caption in the query (the API's upload shape). */
export async function upload<T = unknown>(
	org: string,
	path: string,
	file: File,
	query: Record<string, string>
): Promise<T> {
	const res = await fetch(`/api/v1/orgs/${org}${path}?${new URLSearchParams(query)}`, {
		method: 'POST',
		headers: {
			'content-type': file.type || 'application/octet-stream',
			'idempotency-key': newKey()
		},
		body: file
	});
	const json = (await res.json().catch(() => null)) as {
		error?: { code?: string; message?: string };
	} | null;
	if (!res.ok)
		throw new ApiError(
			res.status,
			json?.error?.code ?? 'ERROR',
			json?.error?.message ?? 'The upload failed.'
		);
	return json as T;
}

/** Sends a picture as the raw body of a PUT, with its type in the query (an avatar or a logo). Throws an ApiError with the server's plain message. */
export async function putPicture(path: string, file: File): Promise<void> {
	const res = await fetch(`/api/v1${path}?type=${encodeURIComponent(file.type)}`, {
		method: 'PUT',
		headers: { 'content-type': file.type },
		body: file
	});
	if (!res.ok) {
		const j = (await res.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		throw new ApiError(
			res.status,
			j?.error?.code ?? 'ERROR',
			j?.error?.message ?? 'The picture was not saved.'
		);
	}
}

/** Removes an avatar or a logo. */
export async function deletePicture(path: string): Promise<void> {
	const res = await fetch(`/api/v1${path}`, { method: 'DELETE' });
	if (!res.ok) {
		const j = (await res.json().catch(() => null)) as {
			error?: { code?: string; message?: string };
		} | null;
		throw new ApiError(
			res.status,
			j?.error?.code ?? 'ERROR',
			j?.error?.message ?? 'The picture was not removed.'
		);
	}
}
