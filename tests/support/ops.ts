// SHARED SETUP FOR OPERATIONS TESTS: ONE ORG WITH PEOPLE IN EVERY ROLE, A PROJECT AND HELPERS TO ACT AS EACH OF THEM

// IMPORTED TYPES
import type { Actor, Ctx } from '../../src/lib/server/ops/context';
import type { TestDb } from './db';

// -- TYPES -- //

export type World = {
	orgId: string;
	projectId: string;
	projectKey: string;
	people: Record<'owner' | 'admin' | 'member' | 'viewer' | 'guest', string>;
	ctx: (who: keyof World['people'], extra?: Partial<Actor> & { requestId?: string }) => Ctx;
	/** A second org with its own project and a member, for cross org checks. */
	other: { orgId: string; projectId: string; userId: string };
};

// -- FUNCTIONS -- //

let counter = 0;

/** Builds the world through a superuser connection (it bypasses row level security, like a seed). */
export async function makeWorld(db: TestDb): Promise<World> {
	const n = ++counter;
	const hex = (k: number) =>
		`00000000-0000-4000-8${String(n % 10)}0${String(Math.floor(n / 10) % 10)}-${String(k).padStart(12, '0')}`;
	const orgId = hex(1);
	const projectId = hex(11);
	const otherOrg = hex(2);
	const otherProject = hex(12);
	const roles = ['owner', 'admin', 'member', 'viewer', 'guest'] as const;
	const people = Object.fromEntries(roles.map((r) => [r, `w${n}-${r}`])) as World['people'];
	const a = db.admin;
	await a.exec(
		`INSERT INTO "user" (id, name, email, email_verified) VALUES ${roles.map((r) => `('${people[r]}', '${r}', '${r}-${n}@example.com', true)`).join(', ')}, ('w${n}-other', 'other', 'other-${n}@example.com', true)`
	);
	await a.exec(
		`INSERT INTO org (id, name, slug) VALUES ('${orgId}', 'World ${n}', 'world-${n}'), ('${otherOrg}', 'Other ${n}', 'other-${n}')`
	);
	await a.exec(
		`INSERT INTO member (org_id, user_id, role) VALUES ${roles.map((r) => `('${orgId}', '${people[r]}', '${r}')`).join(', ')}, ('${otherOrg}', 'w${n}-other', 'owner')`
	);
	const key = `WRL${n}`.slice(0, 8);
	await a.exec(
		`INSERT INTO project (id, org_id, key, name) VALUES ('${projectId}', '${orgId}', '${key}', 'World project'), ('${otherProject}', '${otherOrg}', 'OTH${n}', 'Other project')`
	);
	return {
		orgId,
		projectId,
		projectKey: key,
		people,
		other: { orgId: otherOrg, projectId: otherProject, userId: `w${n}-other` },
		ctx: (who, extra = {}) => {
			const { requestId, ...actor } = extra;
			return {
				handle: db,
				orgId,
				requestId,
				actor: { userId: people[who], kind: 'person', label: who, ...actor }
			};
		}
	};
}

/** A small plan with two phases and four steps, plus two manual checks. */
export const PLAN = {
	phases: [
		{ key: '1', title: 'Build', steps: [{ text: 'Write the code' }, { text: 'Write the tests' }] },
		{ key: '2', title: 'Release', steps: [{ text: 'Run the gates' }, { text: 'Ship' }] }
	],
	manualChecks: [
		{ key: 'M1', text: 'Arben checks it by hand' },
		{ key: 'M2', text: 'Runs by itself', auto: true }
	]
};
