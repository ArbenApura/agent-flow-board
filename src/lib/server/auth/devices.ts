// KNOWN DEVICES AND NEW DEVICE ALERTS (SPEC 6.1). A device is a user agent plus a network prefix, kept only as a hash.

// -- TYPES -- //
import type { Db } from '../db/client';
import type { Mailer } from '../email/mailer';
// -- DEP-MODULES -- //
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
// -- MODULES -- //
import { authDevice, user } from '../db/schema';
import { newDeviceMail } from '../email/templates';

// -- FUNCTIONS -- //

/** The first three parts of an IPv4 address or the first four groups of an IPv6 one, so a changing last part is the same place. */
export function networkPrefix(ip: string | null | undefined): string {
	if (!ip) return 'unknown';
	if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
	return ip.split('.').slice(0, 3).join('.');
}

export function fingerprint(
	userAgent: string | null | undefined,
	ip: string | null | undefined
): string {
	return createHash('sha256')
		.update(`${userAgent ?? 'unknown'}|${networkPrefix(ip)}`)
		.digest('hex')
		.slice(0, 32);
}

/** A short readable label such as "Chrome on Windows", never the full user agent. */
export function deviceLabel(userAgent: string | null | undefined): string {
	const ua = userAgent ?? '';
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Chrome\//.test(ua)
			? 'Chrome'
			: /Firefox\//.test(ua)
				? 'Firefox'
				: /Safari\//.test(ua)
					? 'Safari'
					: /claude|cursor|codex|gemini|antigravity/i.test(ua)
						? (/claude|cursor|codex|gemini|antigravity/i.exec(ua)?.[0] ?? 'Tool')
						: 'A browser';
	const os = /Windows/.test(ua)
		? 'Windows'
		: /Mac OS|Macintosh/.test(ua)
			? 'macOS'
			: /Android/.test(ua)
				? 'Android'
				: /iPhone|iPad/.test(ua)
					? 'iOS'
					: /Linux/.test(ua)
						? 'Linux'
						: 'an unknown system';
	return `${browser} on ${os}`;
}

/**
 * Records a sign in. A device the person has not used before sends an alert, except on their very first device
 * (a new account has nothing to compare with). A failed send never blocks the sign in.
 */
export async function noteSignIn(
	db: Db,
	mailer: Mailer,
	input: { userId: string; userAgent?: string | null; ipAddress?: string | null; now?: Date }
): Promise<{ newDevice: boolean; alerted: boolean }> {
	const fp = fingerprint(input.userAgent, input.ipAddress);
	const now = input.now ?? new Date();
	const known = await db.select().from(authDevice).where(eq(authDevice.userId, input.userId));
	const seen = known.find((d) => d.fingerprint === fp);
	if (seen) {
		await db
			.update(authDevice)
			.set({ lastSeenAt: now })
			.where(and(eq(authDevice.userId, input.userId), eq(authDevice.fingerprint, fp)));
		return { newDevice: false, alerted: false };
	}
	const label = deviceLabel(input.userAgent);
	await db.insert(authDevice).values({
		id: randomUUID(),
		userId: input.userId,
		fingerprint: fp,
		label,
		firstSeenAt: now,
		lastSeenAt: now
	});
	if (known.length === 0) return { newDevice: true, alerted: false };
	const [u] = await db.select().from(user).where(eq(user.id, input.userId));
	if (!u) return { newDevice: true, alerted: false };
	try {
		await mailer.send(newDeviceMail(u.email, u.name, label, now.toUTCString()));
		return { newDevice: true, alerted: true };
	} catch {
		return { newDevice: true, alerted: false };
	}
}
