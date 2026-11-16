// THE CONSENT PAGE LEFT OPEN FOLLOWS ITS OWN APPROVAL TO THE END (AFB-20261116-1440 FOLLOW UP). approvalStatus answers none, waiting, connected or expired, only for the person
// who approved, inside their organisation, and found by the PKCE challenge the page already holds.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	approvalStatus,
	exchangeCode,
	isOAuthError,
	issueCode,
	registerClient
} from '../../src/lib/server/oauth/oauth';
import { makePostgres, type TestDb } from '../support/db';
import { makeWorld, type World } from '../support/ops';

// -- CONSTANTS -- //

const REDIRECT = 'http://127.0.0.1:33418/callback';

// -- FUNCTIONS -- //

describe('approvalStatus', () => {
	let db: TestDb;
	let w: World;
	let clientId: string;

	/** A tool starts, the person approves: the code is issued and the page keeps the challenge. */
	async function approved() {
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const code = await issueCode(db, {
			orgId: w.orgId,
			userId: w.people.admin,
			clientId,
			redirectUri: REDIRECT,
			challenge,
			scopes: ['read']
		});
		if (isOAuthError(code)) throw new Error(code.error_description);
		return { code, verifier, challenge };
	}
	const status = (
		challenge: string,
		who: { orgId: string; userId: string } = { orgId: w.orgId, userId: w.people.admin }
	) => approvalStatus(db, { ...who, clientId, challenge });

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		const r = await registerClient(db, { client_name: 'Claude Code', redirect_uris: [REDIRECT] });
		if (isOAuthError(r)) throw new Error(r.error_description);
		clientId = r.client_id;
	}, 240_000);
	afterAll(() => db?.stop());

	it('is none before anything was approved, and for anything that is not a code of this person', async () => {
		expect(await status('a'.repeat(43))).toBe('none');
		expect(await status('a'.repeat(43), { orgId: 'not-a-uuid', userId: w.people.admin })).toBe(
			'none'
		);
	});

	it('is waiting once approved, connected once the tool redeems the code', async () => {
		const a = await approved();
		expect(await status(a.challenge)).toBe('waiting');
		const tokens = await exchangeCode(db, {
			code: a.code,
			redirectUri: REDIRECT,
			verifier: a.verifier,
			clientId
		});
		expect(isOAuthError(tokens)).toBe(false);
		expect(await status(a.challenge)).toBe('connected');
	});

	it('is expired when the code lapsed unused', async () => {
		const a = await approved();
		await db.admin.exec(
			`update oauth_code set expires_at = now() - interval '1 minute' where code_challenge = '${a.challenge}'`
		);
		expect(await status(a.challenge)).toBe('expired');
	});

	it("never shows another person's or another organisation's approval", async () => {
		const a = await approved();
		// Another member of the same organisation, and a person of the other organisation, both read none
		expect(await status(a.challenge, { orgId: w.orgId, userId: w.people.member })).toBe('none');
		expect(await status(a.challenge, { orgId: w.other.orgId, userId: w.other.userId })).toBe(
			'none'
		);
	});
});
