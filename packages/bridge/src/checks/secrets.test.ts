// TESTS OF THE SEALED SECRETS: EVERY IMPORT RULE, NAMES-ONLY OUTPUT, THE BINDING TO ONE REGISTRATION AND THE USE OF THE VALUES

// -- DEP-MODULES -- //
import {
	copyFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { auditFile, stateDirFor } from './paths.js';
import {
	forgetSecrets,
	importSecrets,
	listSecrets,
	mailInboxOf,
	omitKeys,
	refreshSecrets,
	resolveSealedEnv
} from './secrets.js';

// -- MOCKS -- //

const consume = vi.hoisted(() => vi.fn());
const peek = vi.hoisted(() => vi.fn());
vi.mock('./approve.js', () => ({
	consumeApproval: consume,
	consumeApprovalNote: (a: string, t: string, c: string) => ({ ok: consume(a, t, c) as boolean }),
	boardSentence: () => null,
	peekApproval: peek
}));

// -- CONSTANTS -- //

const ORG = 'acme';
const NAME = 'HAPRM';
const REF = 'test1234';
const URL = `https://${REF}.supabase.co`;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `eyJhbGciOiJIUzI1NiJ9.${b64(claims)}.c2lnbmF0dXJl`;
const ANON = jwt({ role: 'anon', ref: REF });
const SERVICE = jwt({ role: 'service_role', ref: REF });
const TOKEN = 'pm-server-token-abc123';

// -- FUNCTIONS -- //

describe('sealed secrets', () => {
	let home = '';
	let repo = '';
	let before: string | undefined;
	const envFile = (text: string, name = '.env.test') => {
		const f = join(repo, name);
		writeFileSync(f, text);
		return f;
	};
	const base = (file: string, keys: string[], extra: object = {}) => ({
		org: ORG,
		name: NAME,
		repo,
		file,
		keys,
		testRef: REF,
		approval: 'good',
		...extra
	});
	const supa = (extra = '') =>
		`PUBLIC_SUPABASE_URL=${URL}\nPUBLIC_SUPABASE_ANON_KEY=${ANON}\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE}\nATTENDEE_AUTH_SECRET=attendee-secret-value\n${extra}`;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-sec-home-'));
		repo = mkdtempSync(join(tmpdir(), 'afb-sec-repo-'));
		before = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = home;
		peek.mockReset();
		peek.mockImplementation((_a: string, _t: string, code: string) => code === 'good');
		consume.mockReset();
		consume.mockImplementation((_a: string, _t: string, code: string) => code === 'good');
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	it('imports, seals for the registration, lists names only and audits the approval without a value', () => {
		const file = envFile(supa());
		const r = importSecrets(
			base(file, ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'ATTENDEE_AUTH_SECRET'])
		);
		expect(r.keys).toEqual([
			'PUBLIC_SUPABASE_URL',
			'PUBLIC_SUPABASE_ANON_KEY',
			'ATTENDEE_AUTH_SECRET'
		]);
		expect(consume).toHaveBeenCalledWith('secrets', `${ORG}/${NAME}`, 'good');
		const l = listSecrets(ORG, NAME);
		expect(l.keys).toEqual([
			'ATTENDEE_AUTH_SECRET',
			'PUBLIC_SUPABASE_ANON_KEY',
			'PUBLIC_SUPABASE_URL'
		]);
		expect(l.serviceKeys).toEqual([]);
		expect(JSON.stringify(l)).not.toContain('attendee-secret-value');
		const sealed = readFileSync(join(stateDirFor(ORG, NAME), 'secrets.sealed'));
		expect(sealed.includes(Buffer.from('attendee-secret-value'))).toBe(false);
		expect(sealed.includes(Buffer.from(URL))).toBe(false);
		const audit = readFileSync(auditFile(), 'utf8');
		expect(audit).toContain('approved with code');
		expect(audit).not.toContain('attendee-secret-value');
		expect(audit).not.toContain(ANON);
	});

	it('refuses without a valid approval, writes nothing and burns no code for a refused rule', () => {
		const file = envFile(supa());
		expect(() => importSecrets(base(file, ['PUBLIC_SUPABASE_URL'], { approval: 'wrong' }))).toThrow(
			/not approved/
		);
		expect(() => importSecrets(base(file, ['PUBLIC_SUPABASE_URL'], { approval: '' }))).toThrow(
			/not approved/
		);
		expect(listSecrets(ORG, NAME).keys).toEqual([]);
		consume.mockClear();
		expect(() => importSecrets(base(file, ['NODE_OPTIONS']))).toThrow(/cannot be imported/);
		expect(consume).not.toHaveBeenCalled();
	});

	it('imports at most 12 keys', () => {
		const file = envFile(supa());
		const keys = [
			'PUBLIC_SUPABASE_URL',
			'PUBLIC_SUPABASE_ANON_KEY',
			'PUBLIC_SUPABASE_PUBLISHABLE_KEY',
			'NEXT_PUBLIC_SUPABASE_URL',
			'NEXT_PUBLIC_SUPABASE_ANON_KEY',
			'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
			'VITE_SUPABASE_URL',
			'VITE_SUPABASE_ANON_KEY',
			'VITE_SUPABASE_PUBLISHABLE_KEY',
			'SUPABASE_URL',
			'SUPABASE_ANON_KEY',
			'SUPABASE_PUBLISHABLE_KEY',
			'ATTENDEE_AUTH_SECRET'
		];
		expect(keys.length).toBe(13);
		expect(() => importSecrets(base(file, keys))).toThrow(/at most 12/);
	});

	it('only imports allowed Supabase and mail key names', () => {
		const file = envFile(
			supa('NODE_OPTIONS=--require x\nPATH=/x\nDATABASE_URL=postgres://u:p@h/d\n')
		);
		for (const k of ['NODE_OPTIONS', 'PATH', 'DATABASE_URL', 'SOME_API_KEY'])
			expect(() => importSecrets(base(file, ['PUBLIC_SUPABASE_URL', k]))).toThrow(
				new RegExp(`${k} cannot be imported`)
			);
	});

	it('needs a test ref, the URL, and a URL host that equals the ref', () => {
		const file = envFile(supa());
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL'], { testRef: undefined }))
		).toThrow(/--test-ref/);
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL'], { testRef: 'BAD REF' }))
		).toThrow(/--test-ref/);
		expect(() => importSecrets(base(file, ['PUBLIC_SUPABASE_ANON_KEY']))).toThrow(
			/Supabase URL too/
		);
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL'], { testRef: 'otherref99' }))
		).toThrow(/does not belong to the project ref/);
		const http = envFile(`PUBLIC_SUPABASE_URL=http://${REF}.supabase.co\n`);
		expect(() => importSecrets(base(http, ['PUBLIC_SUPABASE_URL']))).toThrow(/not an https/);
		const evil = envFile(`PUBLIC_SUPABASE_URL=https://${REF}.supabase.co.evil.com\n`);
		expect(() => importSecrets(base(evil, ['PUBLIC_SUPABASE_URL']))).toThrow(/does not belong/);
	});

	it('refuses a key signed for another project (ref claim)', () => {
		const other = jwt({ role: 'anon', ref: 'someotherproj' });
		const file = envFile(`PUBLIC_SUPABASE_URL=${URL}\nPUBLIC_SUPABASE_ANON_KEY=${other}\n`);
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY']))
		).toThrow(/signed for another Supabase project/);
	});

	it('refuses service-role keys (by name, by role claim, by prefix) unless allowed, then marks them', () => {
		const file = envFile(supa(), '.env.local');
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']))
		).toThrow(/service key/);
		const byClaim = envFile(
			`PUBLIC_SUPABASE_URL=${URL}\nPUBLIC_SUPABASE_ANON_KEY=${SERVICE}\n`,
			'.env'
		);
		expect(() =>
			importSecrets(base(byClaim, ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY']))
		).toThrow(/PUBLIC_SUPABASE_ANON_KEY is a service key/);
		const byPrefix = envFile(
			`PUBLIC_SUPABASE_URL=${URL}\nPUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_secret_abcdef0123456789\n`
		);
		expect(() =>
			importSecrets(base(byPrefix, ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_PUBLISHABLE_KEY']))
		).toThrow(/service key/);
		const r = importSecrets(
			base(file, ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], { allowServiceRole: true })
		);
		expect(r.serviceKeys).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
		expect(listSecrets(ORG, NAME).serviceKeys).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
	});

	it('reads only .env, .env.local and .env.test, never .env.production or another name', () => {
		const prod = envFile(supa(), '.env.production');
		expect(() => importSecrets(base(prod, ['PUBLIC_SUPABASE_URL']))).toThrow(
			/never \.env\.production/
		);
		const other = envFile(supa(), 'secrets.txt');
		expect(() => importSecrets(base(other, ['PUBLIC_SUPABASE_URL']))).toThrow(
			/not a file an import reads/
		);
		for (const n of ['.env', '.env.local', '.env.test'])
			expect(importSecrets(base(envFile(supa(), n), ['PUBLIC_SUPABASE_URL'])).keys).toEqual([
				'PUBLIC_SUPABASE_URL'
			]);
	});

	it('refuses a file outside the registration repo and a repo-less registration', () => {
		const outside = mkdtempSync(join(tmpdir(), 'afb-sec-out-'));
		try {
			const f = join(outside, '.env');
			writeFileSync(f, supa());
			expect(() => importSecrets(base(f, ['PUBLIC_SUPABASE_URL']))).toThrow(/not inside the repo/);
			expect(() => importSecrets(base(f, ['PUBLIC_SUPABASE_URL'], { repo: undefined }))).toThrow(
				/no repo folder/
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('refuses a missing file and a file that is a link', () => {
		expect(() => importSecrets(base(join(repo, '.env'), ['PUBLIC_SUPABASE_URL']))).toThrow(
			/does not exist/
		);
		const real = envFile(supa(), 'real.txt');
		const link = join(repo, '.env.local');
		try {
			symlinkSync(real, link);
		} catch {
			return; // No right to make links on this machine: the rule is covered by the hard link test
		}
		expect(() => importSecrets(base(link, ['PUBLIC_SUPABASE_URL']))).toThrow(/link or not a file/);
	});

	it('refuses a file with a second name (hard link)', () => {
		const real = envFile(supa(), '.env');
		linkSync(real, join(repo, 'second-name.txt'));
		expect(() => importSecrets(base(real, ['PUBLIC_SUPABASE_URL']))).toThrow(/hard link/);
		expect(listSecrets(ORG, NAME).keys).toEqual([]);
	});

	it('refuses a multi-line value by naming the variable only', () => {
		const file = envFile(`PUBLIC_SUPABASE_URL=${URL}\nATTENDEE_AUTH_SECRET="line one\nline two"\n`);
		const run = () => importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'ATTENDEE_AUTH_SECRET']));
		expect(run).toThrow(/ATTENDEE_AUTH_SECRET has a value over several lines/);
		try {
			run();
		} catch (e) {
			expect((e as Error).message).not.toContain('line one');
		}
	});

	it('refuses a key that is not set', () => {
		const file = envFile(`PUBLIC_SUPABASE_URL=${URL}\nATTENDEE_AUTH_SECRET=\n`);
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'ATTENDEE_AUTH_SECRET']))
		).toThrow(/ATTENDEE_AUTH_SECRET is not set/);
	});

	describe('mail keys', () => {
		const mailEnv = `POSTMARK_SERVER_TOKEN=${TOKEN}\nPOSTMARK_FROM_EMAIL=from@example.com\nPOSTMARK_MESSAGE_STREAM=outbound\n`;
		const mailKeys = ['POSTMARK_SERVER_TOKEN', 'POSTMARK_FROM_EMAIL', 'POSTMARK_MESSAGE_STREAM'];
		const said = 'The owner says this is a test token only';

		it('needs a test inbox that is an email', () => {
			const file = envFile(mailEnv);
			expect(() => importSecrets(base(file, mailKeys, { ownerSaid: said }))).toThrow(
				/--test-inbox/
			);
			expect(() =>
				importSecrets(base(file, mailKeys, { ownerSaid: said, testInbox: 'not-an-email' }))
			).toThrow(/--test-inbox/);
		});
		it('needs an owner sentence of 10+ characters with the word test', () => {
			const file = envFile(mailEnv);
			const withInbox = { testInbox: 'inbox@example.com' };
			expect(() => importSecrets(base(file, mailKeys, withInbox))).toThrow(/test token/);
			expect(() =>
				importSecrets(base(file, mailKeys, { ...withInbox, ownerSaid: 'this is real' }))
			).toThrow(/test token/);
			expect(() =>
				importSecrets(base(file, mailKeys, { ...withInbox, ownerSaid: 'test' }))
			).toThrow(/test token/);
		});
		it('checks each mail value looks like what it is, naming the key', () => {
			const withInbox = { testInbox: 'inbox@example.com', ownerSaid: said };
			const swapped = envFile(
				`POSTMARK_SERVER_TOKEN=${TOKEN}\nPOSTMARK_FROM_EMAIL=not an address\nPOSTMARK_MESSAGE_STREAM=outbound\n`
			);
			expect(() => importSecrets(base(swapped, mailKeys, withInbox))).toThrow(
				/POSTMARK_FROM_EMAIL in \.env\.test does not look like/
			);
			const shortTok = envFile(`POSTMARK_SERVER_TOKEN=abc\n`);
			expect(() => importSecrets(base(shortTok, ['POSTMARK_SERVER_TOKEN'], withInbox))).toThrow(
				/POSTMARK_SERVER_TOKEN in .* does not look like a token/
			);
		});
		it('imports with an inbox and a sentence, needs no test ref, and lists only names', () => {
			const file = envFile(mailEnv);
			const r = importSecrets(
				base(file, mailKeys, {
					testRef: undefined,
					testInbox: 'inbox@example.com',
					ownerSaid: said
				})
			);
			expect(r.testInbox).toBe('inbox@example.com');
			expect(mailInboxOf(ORG, NAME)).toBe('inbox@example.com');
			expect(JSON.stringify(listSecrets(ORG, NAME))).not.toContain(TOKEN);
			expect(readFileSync(auditFile(), 'utf8')).not.toContain(TOKEN);
		});
		it('keeps earlier Supabase values when mail is imported later, and keeps mail when Supabase is re-imported for the same ref', () => {
			importSecrets(base(envFile(supa()), ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY']));
			importSecrets(
				base(envFile(mailEnv), mailKeys, {
					testRef: undefined,
					testInbox: 'inbox@example.com',
					ownerSaid: said
				})
			);
			expect(listSecrets(ORG, NAME).keys).toHaveLength(5);
			importSecrets(base(envFile(supa()), ['PUBLIC_SUPABASE_URL']));
			expect(listSecrets(ORG, NAME).keys).toHaveLength(5);
		});
	});

	it('is bound to its registration: a copy under another name or organisation cannot be opened', () => {
		importSecrets(base(envFile(supa()), ['PUBLIC_SUPABASE_URL']));
		const from = join(stateDirFor(ORG, NAME), 'secrets.sealed');
		mkdirSync(stateDirFor(ORG, 'OTHER'), { recursive: true });
		copyFileSync(from, join(stateDirFor(ORG, 'OTHER'), 'secrets.sealed'));
		expect(() => listSecrets(ORG, 'OTHER')).toThrow(
			/damaged or were made for another registration/
		);
		mkdirSync(stateDirFor('rival', NAME), { recursive: true });
		copyFileSync(from, join(stateDirFor('rival', NAME), 'secrets.sealed'));
		expect(() => listSecrets('rival', NAME)).toThrow(/another registration/);
	});

	it('writes atomically (no temporary file is left) and forgets', () => {
		importSecrets(base(envFile(supa()), ['PUBLIC_SUPABASE_URL']));
		const dir = stateDirFor(ORG, NAME);
		expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
		expect(forgetSecrets(ORG, NAME)).toBe(true);
		expect(forgetSecrets(ORG, NAME)).toBe(false);
		expect(listSecrets(ORG, NAME).keys).toEqual([]);
	});

	it('refreshes from the same file with a fresh approval and needs that approval', () => {
		const file = envFile(`PUBLIC_SUPABASE_URL=${URL}\nATTENDEE_AUTH_SECRET=first-secret-value\n`);
		importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'ATTENDEE_AUTH_SECRET']));
		writeFileSync(file, `PUBLIC_SUPABASE_URL=${URL}\nATTENDEE_AUTH_SECRET=second-secret-value\n`);
		expect(() => refreshSecrets({ org: ORG, name: NAME, repo, approval: 'wrong' })).toThrow(
			/not approved/
		);
		expect(refreshSecrets({ org: ORG, name: NAME, repo, approval: 'good' }).keys).toEqual([
			'PUBLIC_SUPABASE_URL',
			'ATTENDEE_AUTH_SECRET'
		]);
		const r = resolveSealedEnv(ORG, NAME, {
			ATTENDEE_AUTH_SECRET: '{secret:ATTENDEE_AUTH_SECRET}'
		});
		expect(r.env.ATTENDEE_AUTH_SECRET).toBe('second-secret-value');
		expect(() => refreshSecrets({ org: ORG, name: 'NOSTORE', repo, approval: 'good' })).toThrow(
			/Nothing was imported/
		);
	});

	describe('resolveSealedEnv', () => {
		beforeEach(() => {
			importSecrets(
				base(
					envFile(supa()),
					[
						'PUBLIC_SUPABASE_URL',
						'PUBLIC_SUPABASE_ANON_KEY',
						'SUPABASE_SERVICE_ROLE_KEY',
						'ATTENDEE_AUTH_SECRET'
					],
					{ allowServiceRole: true }
				)
			);
			importSecrets(
				base(
					envFile(
						`POSTMARK_SERVER_TOKEN=${TOKEN}\nPOSTMARK_FROM_EMAIL=from@example.com\n`,
						'.env.local'
					),
					['POSTMARK_SERVER_TOKEN', 'POSTMARK_FROM_EMAIL'],
					{
						testRef: undefined,
						testInbox: 'inbox@example.com',
						ownerSaid: 'a test token for previews'
					}
				)
			);
		});

		it('passes an env with no placeholder through untouched', () => {
			const env = { A: 'x' };
			const r = resolveSealedEnv(ORG, NAME, env);
			expect(r.env).toBe(env);
			expect(r.startOnly).toEqual([]);
			expect(r.hosts).toEqual([]);
		});

		it('fills values, marks service and mail settings start-only, adds the one host and the inbox', () => {
			const r = resolveSealedEnv(ORG, NAME, {
				PUBLIC_SUPABASE_URL: '{secret:PUBLIC_SUPABASE_URL}',
				PUBLIC_SUPABASE_ANON_KEY: '{secret:PUBLIC_SUPABASE_ANON_KEY}',
				SUPABASE_SERVICE_ROLE_KEY: '{secret:SUPABASE_SERVICE_ROLE_KEY}',
				POSTMARK_SERVER_TOKEN: '{secret:POSTMARK_SERVER_TOKEN}',
				POSTMARK_FROM_EMAIL: '{secret:POSTMARK_FROM_EMAIL}',
				PUBLIC_PLAIN: 'placeholder'
			});
			expect(r.env.PUBLIC_SUPABASE_URL).toBe(URL);
			expect(r.env.PUBLIC_PLAIN).toBe('placeholder');
			expect(r.startOnly.sort()).toEqual([
				'POSTMARK_FROM_EMAIL',
				'POSTMARK_SERVER_TOKEN',
				'SUPABASE_SERVICE_ROLE_KEY'
			]);
			expect(r.hosts).toEqual([`${REF}.supabase.co`]);
			expect(r.mailInbox).toBe('inbox@example.com');
			expect(r.testRef).toBe(REF);
			const build = omitKeys(r.env, r.startOnly);
			expect(build.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
			expect(build.POSTMARK_SERVER_TOKEN).toBeUndefined();
			expect(build.PUBLIC_SUPABASE_URL).toBe(URL);
		});

		it('redacts every value raw, URL-encoded and base64', () => {
			const r = resolveSealedEnv(ORG, NAME, {
				POSTMARK_SERVER_TOKEN: '{secret:POSTMARK_SERVER_TOKEN}'
			});
			expect(r.redactions).toContain(TOKEN);
			expect(r.redactions).toContain(encodeURIComponent(TOKEN));
			const b = Buffer.from(TOKEN).toString('base64');
			expect(r.redactions).toContain(b);
			expect(r.redactions).toContain(b.replace(/=+$/, ''));
			const f = resolveSealedEnv(ORG, NAME, {
				PUBLIC_SUPABASE_ANON_KEY: '{secret:PUBLIC_SUPABASE_ANON_KEY}'
			});
			expect(f.redactions).toContain(ANON);
		});

		it('never hands a service key to a PUBLIC_, VITE_ or NEXT_PUBLIC_ setting', () => {
			for (const k of [
				'PUBLIC_SUPABASE_ANON_KEY',
				'VITE_SUPABASE_ANON_KEY',
				'NEXT_PUBLIC_SUPABASE_ANON_KEY'
			])
				expect(() =>
					resolveSealedEnv(ORG, NAME, { [k]: '{secret:SUPABASE_SERVICE_ROLE_KEY}' })
				).toThrow(/service key may not be given|browser bundle/);
		});

		it('gives a mail setting only the sealed value of its own name', () => {
			expect(() =>
				resolveSealedEnv(ORG, NAME, { POSTMARK_FROM_EMAIL: '{secret:POSTMARK_SERVER_TOKEN}' })
			).toThrow(/only the sealed value of its own name/);
			expect(() =>
				resolveSealedEnv(ORG, NAME, { PUBLIC_SUPABASE_URL: '{secret:POSTMARK_SERVER_TOKEN}' })
			).toThrow(/only the sealed value of its own name/);
			expect(() =>
				resolveSealedEnv(ORG, NAME, { POSTMARK_SERVER_TOKEN: '{secret:PUBLIC_SUPABASE_URL}' })
			).toThrow(/only the sealed value of its own name/);
		});

		it('refuses a setting that may not take a sealed value and a key that was never imported', () => {
			expect(() =>
				resolveSealedEnv(ORG, NAME, { NODE_OPTIONS: '{secret:ATTENDEE_AUTH_SECRET}' })
			).toThrow(/NODE_OPTIONS may not be given a sealed value/);
			expect(() =>
				resolveSealedEnv(ORG, NAME, { SUPABASE_URL: '{secret:SUPABASE_SECRET_KEY}' })
			).toThrow(/SUPABASE_SECRET_KEY, but it is not imported/);
		});

		it('names the import command when nothing is imported and never echoes a value', () => {
			expect(() =>
				resolveSealedEnv(ORG, 'EMPTY', { PUBLIC_SUPABASE_URL: '{secret:PUBLIC_SUPABASE_URL}' })
			).toThrow(/none are imported.*check secrets import/);
		});
	});

	it('uses the owner code last: a value that fails after the read leaves the code unused (S10)', () => {
		const file = envFile(supa());
		consume.mockClear();
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'ABSENT_SUPABASE_KEY']))
		).toThrow();
		expect(consume).not.toHaveBeenCalled();
		// The service key is refused after the file was read: still no code used
		expect(() =>
			importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']))
		).toThrow(/service key/);
		expect(consume).not.toHaveBeenCalled();
		importSecrets(base(file, ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY']));
		expect(consume).toHaveBeenCalledTimes(1);
	});

	it('says the code is spent when it was used in the instant between the look and the use (S10)', () => {
		const file = envFile(supa());
		consume.mockImplementation(() => false);
		expect(() => importSecrets(base(file, ['PUBLIC_SUPABASE_URL']))).toThrow(/code is spent/);
		expect(listSecrets(ORG, NAME).keys).toEqual([]);
	});
});
