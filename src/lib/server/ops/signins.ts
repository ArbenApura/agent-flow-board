// TEST ACCOUNT SIGN INS, TYPED ONCE ON THE BOARD AND ENCRYPTED IN THE BROWSER TO ONE TOOL MACHINE (AFB-20261108-1444)
// The server keeps ciphertext only. It is bound to org, runner, registration and key id, expires after 24 hours, is never returned to a page, an agent, a history or a change notice,
// and is fetched by the tool's own runner token as a short lease. The bridge acknowledges the attempt with pass or fail, which wipes the ciphertext.
// Threat model: this protects against agent tokens, logs, history and database dumps. It does not protect against a malicious or compromised board operator (who could serve a page
// that encrypts to another key), which is why the form shows the machine key's short fingerprint that the bridge prints too. The same-OS-user caveat applies to the private key.

// IMPORTED TYPES
import type { Ctx } from './context';
import type { DbHandle } from '../db/client';
import type { RunnerAuth } from './environments';
// IMPORTED DEP-MODULES
import { createECDH, createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
// IMPORTED MODULES
import { bridgeSigninEnvelope, runner } from '../db/schema';
import { withTenant } from '../db/tenant';
import { OpError, requireCap, run } from './context';
import { appendOrgEvent } from './settings';
import { SIGNIN_ALG, SIGNIN_MAX_CHARS } from '../../shared/signinCrypto';

// -- CONSTANTS -- //

export const SIGNIN_TTL_HOURS = 24;
export const SIGNIN_LEASE_MINUTES = 2;
const KEY_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REGISTRATION = /^[A-Za-z0-9_-]{1,32}$/;

export const signinKeyInput = z.object({
	keyId: z.string().regex(KEY_ID),
	/** Base64url of the raw uncompressed P-256 public point (65 bytes). */
	publicKey: z.string().regex(/^[A-Za-z0-9_-]{86,90}$/)
});
export const signinStoreInput = z.object({
	runnerId: z.string().uuid(),
	registration: z.string().regex(REGISTRATION),
	keyId: z.string().regex(KEY_ID),
	alg: z.literal(SIGNIN_ALG),
	ciphertext: z.string().min(20).max(SIGNIN_MAX_CHARS)
});
export const signinAckInput = z.object({
	id: z.string().uuid(),
	result: z.enum(['pass', 'fail'])
});

// -- FUNCTIONS -- //

/** The short fingerprint of a public key: 12 hex characters in groups of four. Same rule as the browser and the bridge. */
export function fingerprint(publicKey: string): string {
	const hex = createHash('sha256')
		.update(Buffer.from(publicKey, 'base64url'))
		.digest('hex')
		.slice(0, 12);
	return hex.match(/.{4}/g)!.join('-');
}

function requireWebPerson(ctx: Ctx) {
	const a = ctx.actor;
	if (a.kind !== 'person' || a.tokenId || a.sessionId || a.tokenCaps || a.tool)
		throw new OpError('FORBIDDEN', 'Only a person signed in at the board can do this.');
}

function requireTool(auth: RunnerAuth) {
	if (auth.kind !== 'tool')
		throw new OpError('FORBIDDEN', 'Only the checks tool of a person can do this.');
}

/** Ciphertext that is not the expected envelope is refused, so the board never keeps free text. */
function wellFormed(text: string): boolean {
	try {
		const v = JSON.parse(text) as Record<string, unknown>;
		return (
			v.v === 1 &&
			['epk', 'iv', 'ct'].every(
				(k) => typeof v[k] === 'string' && /^[A-Za-z0-9_-]+$/.test(v[k] as string)
			) &&
			Object.keys(v).length === 4
		);
	} catch {
		return false;
	}
}

async function sweep(tx: Parameters<Parameters<typeof withTenant>[2]>[0], orgId: string) {
	await tx
		.delete(bridgeSigninEnvelope)
		.where(
			and(
				eq(bridgeSigninEnvelope.orgId, orgId),
				or(
					sql`${bridgeSigninEnvelope.expiresAt} <= now()`,
					lt(bridgeSigninEnvelope.updatedAt, sql`now() - interval '7 days'`)
				)
			)
		);
}

// -- THE BRIDGE'S SIDE (RUNNER TOKEN OF KIND TOOL) -- //

/**
 * Publishes the machine's public key. Only the tool's own runner token sets it. A key that differs from the one before replaces it, stamps the change time (the board shows
 * it) and removes the sign ins that were encrypted to the old key.
 */
export async function publishSigninKey(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof signinKeyInput>
) {
	requireTool(auth);
	const input = signinKeyInput.parse(raw);
	const point = Buffer.from(input.publicKey, 'base64url');
	// A point that is not on the curve is refused here, so a form never encrypts to nothing
	try {
		if (point.length !== 65 || point[0] !== 4) throw new Error('shape');
		const probe = createECDH('prime256v1');
		probe.generateKeys();
		probe.computeSecret(point);
	} catch {
		throw new OpError('INVALID', 'That is not a P-256 public key.');
	}
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const [r] = await tx
			.select({ keyId: runner.signinKeyId, key: runner.signinPublicKey })
			.from(runner)
			.where(and(eq(runner.id, auth.runnerId), eq(runner.orgId, auth.orgId)));
		const changed = r?.keyId !== input.keyId || r?.key !== input.publicKey;
		if (changed) {
			await tx
				.update(runner)
				.set({
					signinKeyId: input.keyId,
					signinPublicKey: input.publicKey,
					signinKeyChangedAt: sql`now()`
				})
				.where(eq(runner.id, auth.runnerId));
			await tx.delete(bridgeSigninEnvelope).where(eq(bridgeSigninEnvelope.runnerId, auth.runnerId));
		}
		return { changed, fingerprint: fingerprint(input.publicKey) };
	});
}

/** Leases the waiting ciphertexts of this machine for two minutes: a second fetch inside that time gets none, a crash after the fetch is retried when the lease ends. */
export async function leaseSignins(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: { registration?: string } = {}
) {
	requireTool(auth);
	const only =
		raw.registration && REGISTRATION.test(raw.registration) ? raw.registration.toLowerCase() : null;
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		await sweep(tx, auth.orgId);
		const rows = await tx
			.update(bridgeSigninEnvelope)
			.set({ leasedAt: sql`now()`, updatedAt: sql`now()` })
			.where(
				and(
					eq(bridgeSigninEnvelope.runnerId, auth.runnerId),
					...(only ? [eq(bridgeSigninEnvelope.registration, only)] : []),
					isNull(bridgeSigninEnvelope.consumedAt),
					sql`${bridgeSigninEnvelope.expiresAt} > now()`,
					or(
						isNull(bridgeSigninEnvelope.leasedAt),
						lt(
							bridgeSigninEnvelope.leasedAt,
							sql`now() - make_interval(mins => ${SIGNIN_LEASE_MINUTES})`
						)
					)
				)
			)
			.returning({
				id: bridgeSigninEnvelope.id,
				registration: bridgeSigninEnvelope.registration,
				keyId: bridgeSigninEnvelope.keyId,
				alg: bridgeSigninEnvelope.alg,
				ciphertext: bridgeSigninEnvelope.ciphertext
			});
		return { orgId: auth.orgId, runnerId: auth.runnerId, signins: rows };
	});
}

/** The bridge says the attempt is over: only pass or fail is kept, and the ciphertext is wiped. */
export async function ackSignin(
	handle: DbHandle,
	auth: RunnerAuth,
	raw: z.input<typeof signinAckInput>
) {
	requireTool(auth);
	const input = signinAckInput.parse(raw);
	return withTenant(handle, { orgId: auth.orgId }, async (tx) => {
		const done = await tx
			.update(bridgeSigninEnvelope)
			.set({
				consumedAt: sql`now()`,
				result: input.result,
				ciphertext: '',
				updatedAt: sql`now()`
			})
			.where(
				and(
					eq(bridgeSigninEnvelope.id, input.id),
					eq(bridgeSigninEnvelope.runnerId, auth.runnerId),
					isNull(bridgeSigninEnvelope.consumedAt)
				)
			)
			.returning({ id: bridgeSigninEnvelope.id });
		return { acknowledged: done.length };
	});
}

// -- THE OWNER'S SIDE (A SIGNED-IN PERSON WITH MANAGE) -- //

/** The machines that published a key, with their registrations and the public key the form encrypts to, and where each stored sign in stands. No ciphertext. */
export async function signinTargets(ctx: Ctx) {
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		await sweep(tx, ctx.orgId);
		const machines = await tx
			.select()
			.from(runner)
			.where(and(eq(runner.orgId, ctx.orgId), eq(runner.kind, 'tool')))
			.orderBy(asc(runner.name));
		const rows = await tx
			.select({
				runnerId: bridgeSigninEnvelope.runnerId,
				registration: bridgeSigninEnvelope.registration,
				consumedAt: bridgeSigninEnvelope.consumedAt,
				result: bridgeSigninEnvelope.result,
				expiresAt: bridgeSigninEnvelope.expiresAt
			})
			.from(bridgeSigninEnvelope)
			.where(eq(bridgeSigninEnvelope.orgId, ctx.orgId));
		return {
			orgId: ctx.orgId,
			machines: machines
				.filter((m) => m.signinKeyId && m.signinPublicKey)
				.map((m) => ({
					runnerId: m.id,
					name: m.name,
					keyId: m.signinKeyId as string,
					publicKey: m.signinPublicKey as string,
					fingerprint: fingerprint(m.signinPublicKey as string),
					keyChangedAt: m.signinKeyChangedAt?.toISOString() ?? null,
					registrations: [...new Set((m.registrations ?? []).map((r) => r.name))]
				})),
			stored: rows.map((r) => ({
				runnerId: r.runnerId,
				registration: r.registration,
				state: r.consumedAt ? ('used' as const) : ('waiting' as const),
				result: r.result,
				expiresAt: r.expiresAt.toISOString()
			}))
		};
	});
}

/**
 * Stores the ciphertext the browser made. Needs a signed-in person with manage. The machine must hold the key id the browser used and the registration, so a ciphertext for a
 * replaced key or for a registration the machine does not have is refused. One per machine and registration: a new one replaces the old.
 */
export async function storeSignin(ctx: Ctx, raw: z.input<typeof signinStoreInput>) {
	requireWebPerson(ctx);
	const input = signinStoreInput.parse(raw);
	if (!wellFormed(input.ciphertext))
		throw new OpError('INVALID', 'That sign in was not packed the way the board expects.');
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const [m] = await tx
			.select()
			.from(runner)
			.where(
				and(eq(runner.id, input.runnerId), eq(runner.orgId, ctx.orgId), eq(runner.kind, 'tool'))
			);
		if (!m || m.signinKeyId !== input.keyId)
			throw new OpError('CONFLICT', 'That machine changed its key. Reload the page and try again.');
		const held = (m.registrations ?? []).some(
			(r) => r.name.toLowerCase() === input.registration.toLowerCase()
		);
		if (!held) throw new OpError('INVALID', 'That machine does not hold this site.');
		await tx
			.insert(bridgeSigninEnvelope)
			.values({
				orgId: ctx.orgId,
				runnerId: m.id,
				registration: input.registration.toLowerCase(),
				keyId: input.keyId,
				alg: input.alg,
				ciphertext: input.ciphertext,
				createdBy: ctx.actor.userId,
				expiresAt: sql`now() + make_interval(hours => ${SIGNIN_TTL_HOURS})`
			})
			.onConflictDoUpdate({
				target: [bridgeSigninEnvelope.runnerId, bridgeSigninEnvelope.registration],
				set: {
					keyId: input.keyId,
					alg: input.alg,
					ciphertext: input.ciphertext,
					createdBy: ctx.actor.userId,
					expiresAt: sql`now() + make_interval(hours => ${SIGNIN_TTL_HOURS})`,
					leasedAt: null,
					consumedAt: null,
					result: null,
					updatedAt: sql`now()`
				}
			});
		// The history says that a sign in was stored for a site, never what it holds
		await appendOrgEvent(
			tx,
			ctx,
			'signin.store',
			{},
			{ registration: input.registration, machine: m.name }
		);
		return { stored: true };
	});
}

/** Removes the stored sign in of a site on a machine (the owner changed their mind). */
export async function discardSignin(ctx: Ctx, runnerId: string, registration: string) {
	requireWebPerson(ctx);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const done = await tx
			.delete(bridgeSigninEnvelope)
			.where(
				and(
					eq(bridgeSigninEnvelope.orgId, ctx.orgId),
					eq(bridgeSigninEnvelope.runnerId, runnerId),
					inArray(bridgeSigninEnvelope.registration, [registration.toLowerCase()])
				)
			)
			.returning({ id: bridgeSigninEnvelope.id });
		return { discarded: done.length };
	});
}
