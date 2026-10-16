// WHERE TO GO AFTER SIGNING IN. ONLY A PATH ON THIS SITE, NEVER AN ADDRESS ON ANOTHER SITE (OPEN REDIRECT).

// -- FUNCTIONS -- //

export function safeNext(value: FormDataEntryValue | string | null | undefined): string {
	if (typeof value !== 'string') return '/';
	// A single leading slash, no protocol relative "//", no backslash tricks, no control characters
	if (!value.startsWith('/') || value.startsWith('//')) return '/';
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (ch === String.fromCharCode(92) || code < 32 || code === 127) return '/';
	}
	return value;
}
