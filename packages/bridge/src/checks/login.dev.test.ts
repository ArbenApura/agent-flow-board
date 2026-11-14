// MULTI-PROFILE SIGN-IN AND SEEDED OPTION TESTS FOR DEV REGISTRATIONS (STEP A.4, AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { mintApproval } from './approve.js';
import { loginCommand } from './login.js';
import { stateDirFor } from './paths.js';
import { profileKey, loadProfileChecked, listProfiles } from './profiles.js';
import { registerProject } from './registry.js';

// -- FUNCTIONS -- //

describe('dev sign-in profiles and seeded option', () => {
	let base = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-logindev-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		mkdirSync(process.env.AFB_BRIDGE_HOME, { recursive: true });
		registerProject({ org: 'acme', name: 'CLINIC', devUrl: 'http://localhost:5173' });
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	});

	it('saves sealed isolated profiles (patient, doctor, staff) via --profile and never leaks secrets to disk or logs', async () => {
		const logs: string[] = [];
		const out: string[] = [];
		const seededTokens: Record<string, string> = {
			patient: 'tok-patient-secret-999',
			doctor: 'tok-doctor-secret-888',
			staff: 'tok-staff-secret-777'
		};

		for (const profile of ['patient', 'doctor', 'staff'] as const) {
			const code = await loginCommand(
				[
					'CLINIC',
					'--org',
					'acme',
					'--profile',
					profile,
					'--seeded',
					`http://localhost:5173/dev/seed?role=${profile}`
				],
				{
					json: true,
					log: (l) => logs.push(l),
					out: (l) => out.push(l),
					deps: {
						target: async () => ({
							baseUrl: 'http://localhost:5173',
							hosts: [],
							stop: async () => undefined
						}),
						seedFromUrl: async (_baseUrl, _seedUrl, p) => ({
							cookies: [
								{
									name: 'session',
									value: seededTokens[p],
									domain: 'localhost',
									path: '/'
								}
							],
							origins: []
						})
					}
				}
			);
			expect(code).toBe(0);
		}

		const listed = listProfiles('acme', 'CLINIC');
		expect(listed.map((e) => e.profile).sort()).toEqual(['doctor', 'patient', 'staff']);

		// Cross-profile isolation: loading each profile yields only its own sealed cookie
		for (const profile of ['patient', 'doctor', 'staff'] as const) {
			const loaded = loadProfileChecked(
				'acme',
				'CLINIC',
				profileKey('http://localhost:5173', profile)
			);
			expect(loaded.damaged).toBe(false);
			const state = loaded.profile?.state as { cookies: { value: string }[] };
			expect(state.cookies[0]?.value).toBe(seededTokens[profile]);
		}

		// Sealed files on disk must NOT contain plaintext session tokens, and logs must never expose them
		const dir = join(stateDirFor('acme', 'CLINIC'), 'profiles');
		for (const file of readdirSync(dir)) {
			const raw = readFileSync(join(dir, file), 'utf8');
			for (const tok of Object.values(seededTokens)) {
				expect(raw).not.toContain(tok);
			}
		}
		const allOutput = [...logs, ...out].join('\n');
		for (const tok of Object.values(seededTokens)) {
			expect(allOutput).not.toContain(tok);
		}
	});

	it('refuses a cross-origin --seeded URL with no profile saved', async () => {
		const logs: string[] = [];
		const code = await loginCommand(
			['CLINIC', '--org', 'acme', '--profile', 'patient', '--seeded', 'https://evil.example/seed'],
			{
				json: false,
				log: (l) => logs.push(l),
				out: () => {},
				deps: {
					target: async () => ({
						baseUrl: 'http://localhost:5173',
						hosts: [],
						stop: async () => undefined
					})
				}
			}
		);
		expect(code).toBe(1);
		expect(logs.join(' ')).toMatch(/must match/i);
		expect(listProfiles('acme', 'CLINIC')).toHaveLength(0);
	});

	it('refuses an unapproved --seeded command with zero process spawns, then runs with owner approval and env credentials', async () => {
		const seedCalls: string[][] = [];
		const logs: string[] = [];
		const password = 'secret-patient-password-xyz';
		const refusedCode = await loginCommand(
			['CLINIC', '--org', 'acme', '--profile', 'patient', '--seeded', 'node scripts/seed.js'],
			{
				json: false,
				log: (l) => logs.push(l),
				out: () => {},
				deps: {
					target: async () => ({
						baseUrl: 'http://localhost:5173',
						hosts: [],
						stop: async () => undefined
					}),
					env: {
						AFB_CHECKS_CLINIC_PATIENT_EMAIL: 'patient@clinic.test',
						AFB_CHECKS_CLINIC_PATIENT_PASSWORD: password
					},
					seedCommand: async (argv) => {
						seedCalls.push(argv);
					},
					signIn: async (_baseUrl, account) => ({
						cookies: [
							{ name: 'sid', value: `cookie-for-${account.email}`, domain: 'localhost', path: '/' }
						],
						origins: []
					})
				}
			}
		);
		expect(refusedCode).toBe(1);
		expect(seedCalls).toHaveLength(0);
		expect(listProfiles('acme', 'CLINIC')).toHaveLength(0);

		const approval = mintApproval('login', 'acme/CLINIC', { isTTY: true }).code;
		const code = await loginCommand(
			[
				'CLINIC',
				'--org',
				'acme',
				'--profile',
				'patient',
				'--seeded',
				'node scripts/seed.js',
				'--approval',
				approval
			],
			{
				json: false,
				log: (l) => logs.push(l),
				out: () => {},
				deps: {
					target: async () => ({
						baseUrl: 'http://localhost:5173',
						hosts: [],
						stop: async () => undefined
					}),
					env: {
						AFB_CHECKS_CLINIC_PATIENT_EMAIL: 'patient@clinic.test',
						AFB_CHECKS_CLINIC_PATIENT_PASSWORD: password
					},
					seedCommand: async (argv) => {
						seedCalls.push(argv);
					},
					signIn: async (_baseUrl, account) => ({
						cookies: [
							{ name: 'sid', value: `cookie-for-${account.email}`, domain: 'localhost', path: '/' }
						],
						origins: []
					})
				}
			}
		);
		expect(code).toBe(0);
		expect(seedCalls).toEqual([['node', 'scripts/seed.js']]);
		expect(logs.join('\n')).not.toContain(password);

		// Replaying the same single-use approval code for a second --seeded command run is refused
		const replayCode = await loginCommand(
			[
				'CLINIC',
				'--org',
				'acme',
				'--profile',
				'patient',
				'--seeded',
				'node scripts/seed.js',
				'--approval',
				approval
			],
			{
				json: false,
				log: (l) => logs.push(l),
				out: () => {},
				deps: {
					target: async () => ({
						baseUrl: 'http://localhost:5173',
						hosts: [],
						stop: async () => undefined
					}),
					env: {
						AFB_CHECKS_CLINIC_PATIENT_EMAIL: 'patient@clinic.test',
						AFB_CHECKS_CLINIC_PATIENT_PASSWORD: password
					},
					seedCommand: async (argv) => {
						seedCalls.push(argv);
					},
					signIn: async (_baseUrl, account) => ({
						cookies: [
							{ name: 'sid', value: `cookie-for-${account.email}`, domain: 'localhost', path: '/' }
						],
						origins: []
					})
				}
			}
		);
		expect(replayCode).toBe(1);
		expect(seedCalls).toEqual([['node', 'scripts/seed.js']]);
		const loaded = loadProfileChecked(
			'acme',
			'CLINIC',
			profileKey('http://localhost:5173', 'patient')
		);
		expect((loaded.profile?.state as { cookies: { value: string }[] }).cookies[0]?.value).toBe(
			'cookie-for-patient@clinic.test'
		);

		// Boolean `--seeded` placed before positional <NAME> preserves the registration name
		const boolCode = await loginCommand(
			['--org', 'acme', '--seeded', 'CLINIC', '--profile', 'doctor'],
			{
				json: false,
				log: (l) => logs.push(l),
				out: () => {},
				deps: {
					target: async () => ({
						baseUrl: 'http://localhost:5173',
						hosts: [],
						stop: async () => undefined
					}),
					env: {
						AFB_CHECKS_CLINIC_DOCTOR_EMAIL: 'doctor@clinic.test',
						AFB_CHECKS_CLINIC_DOCTOR_PASSWORD: password
					},
					signIn: async (_baseUrl, account) => ({
						cookies: [
							{ name: 'sid', value: `cookie-for-${account.email}`, domain: 'localhost', path: '/' }
						],
						origins: []
					})
				}
			}
		);
		expect(boolCode).toBe(0);
	});
});
