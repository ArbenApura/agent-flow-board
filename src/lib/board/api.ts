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
	init: { method?: string; body?: unknown; key?: string } = {}
): Promise<T> {
	const res = await fetch(`/api/v1/orgs/${org}${path}`, {
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
