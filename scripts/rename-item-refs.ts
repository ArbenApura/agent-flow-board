// RENAME EXISTING ITEMS TO <PROJECT KEY>-YYYYMMDD-HHMM (UTC): yarn tsx scripts/rename-item-refs.ts [--apply] (FLOW-20261017-0950)
// A dry run by default: it prints what would change and writes nothing. --apply changes data. For any DATABASE_URL, --apply also needs
// AFB_ALLOW_RENAME_REMOTE=1. Without DATABASE_URL it uses the local PGlite folder in .afb/dev-db. The URL is never printed.
import { createPglite, createPostgres } from '../src/lib/server/db/client';
import { liveOrgIds, renameOrg, type OrgPlan } from '../src/lib/server/db/renameRefs';

const apply = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (apply && url && !process.env.AFB_ALLOW_RENAME_REMOTE) {
	console.error(
		'Refusing to rename items on a database server. Read the dry run first, then set AFB_ALLOW_RENAME_REMOTE=1 for that run only.'
	);
	process.exit(1);
}
const handle = url ? await createPostgres({ ownerUrl: url }) : await createPglite('.afb/dev-db');
const show = (p: OrgPlan) => {
	console.log(
		`Org ${p.orgId}: ${p.renames.length} to rename, ${p.alreadyDone} already in the new form, ${p.skipped.length} skipped.`
	);
	for (const r of p.renames) console.log(`  ${r.from} -> ${r.to}  (from the ${r.source})`);
	for (const s of p.skipped) console.log(`  skipped ${s.ref}: ${s.reason}`);
};
try {
	console.log(
		url ? 'Database: a PostgreSQL server' : 'Database: the local PGlite folder .afb/dev-db'
	);
	const orgs = await liveOrgIds(handle);
	console.log(
		`${orgs.length} org${orgs.length === 1 ? '' : 's'}. ${apply ? 'APPLYING.' : 'Dry run, nothing is written.'}`
	);
	// The counts are always read first and shown, and an apply only goes ahead when the count it finds is the one shown
	const plans: OrgPlan[] = [];
	for (const orgId of orgs) {
		const plan = await renameOrg(handle, orgId);
		show(plan);
		plans.push(plan);
	}
	const total = plans.reduce((n, p) => n + p.renames.length, 0);
	console.log(`In all: ${total} to rename.`);
	if (apply) {
		let applied = 0;
		let orgsDone = 0;
		try {
			for (const shown of plans) {
				const done = await renameOrg(handle, shown.orgId, {
					apply: true,
					expected: shown.renames.length
				});
				applied += done.applied;
				orgsDone++;
			}
		} catch (error) {
			// Each org is one transaction, so the orgs before this one are done and this one is untouched. Running it again is safe.
			console.error(
				`Stopped after ${orgsDone} of ${plans.length} orgs (${applied} items renamed). The failing org was not changed. Run it again: an item already renamed is left alone.`
			);
			throw error;
		}
		console.log(`Renamed ${applied} items. The old references are kept as aliases.`);
	} else if (total) {
		console.log('Run again with --apply to make these changes.');
	}
} finally {
	await handle.close();
}
