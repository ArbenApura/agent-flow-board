// THE SECRET VAULT: ONE DATA KEY PER ORGANISATION, WRAPPED BY A MASTER KEY THAT NEVER SITS IN THE DATABASE OR A BACKUP (ADR-024)
// A project secret (a test account's email and password) is sealed with its org's data key. The data key is stored wrapped by the
// master key from AFB_MASTER_KEY. Every sealed value is bound to its org, project and name, so a row copied to another place does
// not open. Rotating the master key re-wraps the data keys and leaves every secret as it is.

// IMPORTED TYPES
import type { Tx } from '../db/client';
import type { Admin } from '../backup/admin';
// IMPORTED DEP-MODULES
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
// IMPORTED MODULES
import { orgDataKey } from '../db/schema';
import { OpError } from '../ops/context';

// -- CONSTANTS -- //

const WRAP_INFO = 'afb-master-wrap-v1';

// -- FUNCTIONS -- //

/** Refuses to work without a master key, so a missing setting fails loudly instead of storing a secret in the clear. */
export function requireMasterKey(master: string | undefined): string {
	if (!master || master.length < 32)
		throw new OpError(
			'INVALID',
			'Secrets are not set up on this server. Set AFB_MASTER_KEY to at least 32 random characters.'
		);
	return master;
}

const wrapKeyOf = (master: string) =>
	Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), WRAP_INFO, 32));

function aesGcmSeal(key: Buffer, plain: Uint8Array, aad: string): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	cipher.setAAD(Buffer.from(aad));
	const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
	return Buffer.concat([nonce, enc]).toString('base64');
}

function aesGcmOpen(key: Buffer, sealed: string, aad: string): Buffer {
	const raw = Buffer.from(sealed, 'base64');
	if (raw.length < 12 + 16) throw new OpError('INVALID', 'The sealed value is damaged.');
	const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	try {
		return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
	} catch {
		throw new OpError(
			'INVALID',
			'The secret could not be opened. The master key may have changed, or the value was moved.'
		);
	}
}

const wrapAad = (orgId: string, version: number) => `org:${orgId}:v${version}`;
const secretAad = (orgId: string, projectId: string, name: string) =>
	`secret:${orgId}:${projectId}:${name}`;

/** The org's current data key, made on first use. */
export async function dataKeyFor(
	tx: Tx,
	orgId: string,
	masterKey: string | undefined
): Promise<{ version: number; key: Buffer }> {
	const master = requireMasterKey(masterKey);
	const [row] = await tx
		.select()
		.from(orgDataKey)
		.where(eq(orgDataKey.orgId, orgId))
		.orderBy(desc(orgDataKey.keyVersion))
		.limit(1);
	if (row)
		return {
			version: row.keyVersion,
			key: aesGcmOpen(wrapKeyOf(master), row.wrappedKey, wrapAad(orgId, row.keyVersion))
		};
	const key = randomBytes(32);
	await tx.insert(orgDataKey).values({
		orgId,
		keyVersion: 1,
		wrappedKey: aesGcmSeal(wrapKeyOf(master), key, wrapAad(orgId, 1))
	});
	return { version: 1, key };
}

/** The data key of the version that sealed a secret. */
async function dataKeyOfVersion(tx: Tx, orgId: string, master: string, version: number) {
	const [row] = await tx
		.select()
		.from(orgDataKey)
		.where(and(eq(orgDataKey.orgId, orgId), eq(orgDataKey.keyVersion, version)));
	if (!row) throw new OpError('INVALID', 'The key that sealed this secret is gone.');
	return aesGcmOpen(wrapKeyOf(master), row.wrappedKey, wrapAad(orgId, version));
}

/** Seals a value for one secret. Returns what the secret row stores. */
export async function sealSecret(
	tx: Tx,
	where: { orgId: string; projectId: string; name: string },
	value: string,
	masterKey: string | undefined
) {
	const dk = await dataKeyFor(tx, where.orgId, masterKey);
	const sealed = aesGcmSeal(
		dk.key,
		Buffer.from(value, 'utf8'),
		secretAad(where.orgId, where.projectId, where.name)
	);
	// The nonce is the first twelve bytes of the sealed text; it is kept apart as well so a stored row reads clearly
	return { ciphertext: sealed, nonce: sealed.slice(0, 16), keyVersion: dk.version };
}

/** Opens a sealed secret. Only the runner API and the sign-in step of a run call this. */
export async function openSecret(
	tx: Tx,
	row: { orgId: string; projectId: string; name: string; ciphertext: string; keyVersion: number },
	masterKey: string | undefined
): Promise<string> {
	const master = requireMasterKey(masterKey);
	const key = await dataKeyOfVersion(tx, row.orgId, master, row.keyVersion);
	return aesGcmOpen(key, row.ciphertext, secretAad(row.orgId, row.projectId, row.name)).toString(
		'utf8'
	);
}

/**
 * Re-wraps every org's data keys with a new master key (the server command `rotate-master-key`). Reads and writes through the
 * privileged connection because it touches every org. A wrong old key stops before anything is changed.
 */
export async function rotateMasterKey(admin: Admin, oldMaster: string, newMaster: string) {
	requireMasterKey(oldMaster);
	requireMasterKey(newMaster);
	if (oldMaster === newMaster)
		throw new OpError('INVALID', 'The new master key is the same as the old one.');
	return admin.tx(async (q) => {
		const rows = await q.query<{
			id: string;
			org_id: string;
			key_version: number;
			wrapped_key: string;
		}>('select id, org_id, key_version, wrapped_key from org_data_key');
		const next = rows.map((r) => {
			const key = aesGcmOpen(wrapKeyOf(oldMaster), r.wrapped_key, wrapAad(r.org_id, r.key_version));
			return {
				id: r.id,
				wrapped: aesGcmSeal(wrapKeyOf(newMaster), key, wrapAad(r.org_id, r.key_version))
			};
		});
		for (const n of next)
			await q.query('update org_data_key set wrapped_key = $1 where id = $2', [n.wrapped, n.id]);
		return { rewrapped: next.length };
	});
}
