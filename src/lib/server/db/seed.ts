// SAMPLE DATA FOR LOCAL DEVELOPMENT, THE UI SHOTS AND THE LOAD TESTS (3.9)
// Written as a superuser, which bypasses row level security. Never run against a real deployment.

// -- TYPES -- //
import type { SqlExecutor } from './executor';

// -- TYPES -- //

export type SeedIds = {
	acme: string;
	lumora: string;
	checkout: string;
	web: string;
	load: string;
	lumoraProject: string;
	firstItem: string;
};

// -- CONSTANTS -- //

const uuid = (kind: number, n: number) =>
	`00000000-0000-4000-8${kind}00-${String(n).padStart(12, '0')}`;

export const SEED: SeedIds = {
	acme: uuid(0, 1),
	lumora: uuid(0, 2),
	checkout: uuid(1, 1),
	web: uuid(1, 2),
	load: uuid(1, 3),
	lumoraProject: uuid(1, 4),
	firstItem: uuid(2, 1)
};

export const SEED_USERS = [
	{
		id: 'seed-owner',
		name: 'Olivia Owner',
		email: 'owner@acme.example',
		org: 'acme',
		role: 'owner'
	},
	{ id: 'seed-admin', name: 'Adam Admin', email: 'admin@acme.example', org: 'acme', role: 'admin' },
	{
		id: 'seed-member',
		name: 'Maria Member',
		email: 'member@acme.example',
		org: 'acme',
		role: 'member'
	},
	{
		id: 'seed-viewer',
		name: 'Victor Viewer',
		email: 'viewer@acme.example',
		org: 'acme',
		role: 'viewer'
	},
	{
		id: 'seed-lumora-owner',
		name: 'Lena Lumora',
		email: 'owner@lumora.example',
		org: 'lumora',
		role: 'owner'
	}
] as const;

// -- FUNCTIONS -- //

/** Two orgs, a few projects with real looking items, and one project with `loadItems` items for performance tests. */
export async function seedDemo(
	db: SqlExecutor,
	options: { loadItems?: number } = {}
): Promise<SeedIds> {
	const loadItems = options.loadItems ?? 5000;
	const orgId = { acme: SEED.acme, lumora: SEED.lumora };
	await db.exec(
		`INSERT INTO "user" (id, name, email, email_verified) VALUES ${SEED_USERS.map((u) => `('${u.id}', '${u.name}', '${u.email}', true)`).join(', ')} ON CONFLICT DO NOTHING`
	);
	await db.exec(
		`INSERT INTO org (id, name, slug) VALUES ('${SEED.acme}', 'Acme', 'acme'), ('${SEED.lumora}', 'Lumora', 'lumora') ON CONFLICT DO NOTHING`
	);
	await db.exec(
		`INSERT INTO member (org_id, user_id, role) VALUES ${SEED_USERS.map((u) => `('${orgId[u.org]}', '${u.id}', '${u.role}')`).join(', ')} ON CONFLICT DO NOTHING`
	);
	await db.exec(`INSERT INTO project (id, org_id, key, name, web_app) VALUES
		('${SEED.checkout}', '${SEED.acme}', 'CKT', 'Checkout rebuild', true),
		('${SEED.web}', '${SEED.acme}', 'WEB', 'Marketing site', true),
		('${SEED.load}', '${SEED.acme}', 'LOAD', 'Load test project', false),
		('${SEED.lumoraProject}', '${SEED.lumora}', 'LUM', 'Lumora launch', false)
		ON CONFLICT DO NOTHING`);
	// Named items with phases and steps, so every board page has something real to show
	const named = [
		['Saved cards at checkout', 'SAVED_CARDS', 'IN PROGRESS'],
		['Tax lines on invoices', 'TAX_LINES', 'IN REVIEW'],
		['Promo codes', 'PROMO_CODES', 'PLANNED'],
		['Receipts email', 'RECEIPTS_EMAIL', 'COMPLETED'],
		['Gift wrap option', 'GIFT_WRAP', 'ON HOLD']
	] as const;
	for (const [i, [title, tab, status]] of named.entries()) {
		const id = i === 0 ? SEED.firstItem : uuid(2, i + 1);
		await db.exec(
			`INSERT INTO item (id, org_id, project_id, number, ref, title, tab_name, status) VALUES ('${id}', '${SEED.acme}', '${SEED.checkout}', ${i + 1}, 'CKT-${i + 1}', '${title}', '${tab}', '${status}') ON CONFLICT DO NOTHING`
		);
		const phaseId = uuid(3, i + 1);
		await db.exec(
			`INSERT INTO phase (id, org_id, project_id, item_id, key, title, position) VALUES ('${phaseId}', '${SEED.acme}', '${SEED.checkout}', '${id}', '1', 'Build', 1) ON CONFLICT DO NOTHING`
		);
		for (let k = 1; k <= 4; k++) {
			const state =
				status === 'COMPLETED' || status === 'IN REVIEW'
					? 'done'
					: k <= (status === 'IN PROGRESS' ? 2 : 0)
						? 'done'
						: 'open';
			await db.exec(
				`INSERT INTO step (org_id, project_id, item_id, phase_id, key, text, state, position) VALUES ('${SEED.acme}', '${SEED.checkout}', '${id}', '${phaseId}', '1.${k}', 'Step ${k} of ${title}', '${state}', ${k}) ON CONFLICT DO NOTHING`
			);
		}
		const done =
			status === 'COMPLETED' || status === 'IN REVIEW' ? 4 : status === 'IN PROGRESS' ? 2 : 0;
		await db.exec(
			`UPDATE item SET done_steps = ${done}, total_steps = 4, percent = ${done * 25} WHERE id = '${id}'`
		);
	}
	await db.exec(
		`INSERT INTO project_counter (project_id, org_id, next, next_task) VALUES ('${SEED.checkout}', '${SEED.acme}', ${named.length + 1}, 1), ('${SEED.web}', '${SEED.acme}', 1, 1), ('${SEED.lumoraProject}', '${SEED.lumora}', 1, 1) ON CONFLICT DO NOTHING`
	);
	// A little history for the named items, so the activity pages have rows to show
	await db.exec(`INSERT INTO event (org_id, project_id, item_id, actor_user_id, actor_label, verb, target_type, target_id, after, undoable)
		SELECT i.org_id, i.project_id, i.id, 'seed-owner', 'Olivia Owner', 'item.create', 'item', i.id::text,
			jsonb_build_object('title', i.title, 'ref', i.ref), true
		FROM item i WHERE i.project_id = '${SEED.checkout}'
		AND NOT EXISTS (SELECT 1 FROM event e WHERE e.item_id = i.id)`);
	await db.exec(`INSERT INTO event (org_id, project_id, item_id, actor_user_id, actor_label, tool, verb, target_type, target_id, after, undoable)
		SELECT i.org_id, i.project_id, i.id, 'seed-member', 'Claude Code', 'Claude Code', 'item.status', 'item', i.id::text,
			jsonb_build_object('status', i.status, 'note', 'Automatic'), false
		FROM item i WHERE i.project_id = '${SEED.checkout}' AND i.status <> 'PLANNED'
		AND NOT EXISTS (SELECT 1 FROM event e WHERE e.item_id = i.id AND e.verb = 'item.status')`);
	// Work the health panel can show: a commit nobody recorded, a quiet item in progress, and an item ready for sign-off
	await db.exec(`INSERT INTO commit_link (org_id, project_id, item_id, sha, repo, message, matched_by, recorded, files)
		SELECT i.org_id, i.project_id, i.id, repeat('a', 40), 'acme/checkout', 'Add saved cards to checkout', 'trailer', false, '["src/cards.ts"]'::jsonb
		FROM item i WHERE i.id = '${SEED.firstItem}' ON CONFLICT DO NOTHING`);
	await db.exec(
		`UPDATE item SET last_activity_at = now() - interval '10 days' WHERE id = '${SEED.firstItem}'`
	);
	await db.exec(
		`UPDATE item SET health = '{"flags":[],"drift":["ready-for-sign-off"]}'::jsonb WHERE project_id = '${SEED.checkout}' AND number = 2`
	);
	// The load project: thousands of items in one statement
	await db.exec(`INSERT INTO item (org_id, project_id, number, ref, title, tab_name, status, percent, done_steps, total_steps)
		SELECT '${SEED.acme}', '${SEED.load}', n, 'LOAD-' || n, 'Load item number ' || n,
			'LOAD_' || n,
			(ARRAY['PLANNED','IN PROGRESS','IN REVIEW','ON HOLD','COMPLETED'])[1 + (n % 5)],
			(n * 7) % 101, (n * 7) % 11, 10
		FROM generate_series(1, ${loadItems}) AS n ON CONFLICT DO NOTHING`);
	await db.exec(
		`INSERT INTO project_counter (project_id, org_id, next, next_task) VALUES ('${SEED.load}', '${SEED.acme}', ${loadItems + 1}, 1) ON CONFLICT (project_id) DO UPDATE SET next = ${loadItems + 1}`
	);
	return SEED;
}
