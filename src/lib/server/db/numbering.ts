// ATOMIC ITEM AND TASK NUMBERS FROM A PER PROJECT COUNTER ROW (SPEC 5)
// The counter row is locked by the upsert and the lock lasts until the transaction ends, so two concurrent creates
// can never share a number, and a rolled back create gives its number back (no gaps from failures).

// -- TYPES -- //
import type { Tx } from './client';
// -- DEP-MODULES -- //
import { eq, sql } from 'drizzle-orm';
// -- MODULES -- //
import { project } from './schema';

// -- FUNCTIONS -- //

type CounterColumn = 'next' | 'next_task';

async function take(
	tx: Tx,
	orgId: string,
	projectId: string,
	column: CounterColumn
): Promise<number> {
	const other = column === 'next' ? 'next_task' : 'next';
	const res = await tx.execute(
		sql.raw(
			`insert into project_counter (project_id, org_id, ${column}, ${other}) values ('${projectId}', '${orgId}', 2, 1)
			 on conflict (project_id) do update set ${column} = project_counter.${column} + 1
			 returning ${column} - 1 as n`
		)
	);
	return Number((res as unknown as { rows: { n: number }[] }).rows[0].n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string) {
	if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/** The next item number and its readable reference, for example { number: 142, ref: 'HAPR-142' }. */
export async function allocateItemNumber(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<{ number: number; ref: string }> {
	assertUuid(orgId, 'orgId');
	assertUuid(projectId, 'projectId');
	const [p] = await tx.select({ key: project.key }).from(project).where(eq(project.id, projectId));
	if (!p) throw new Error('Project not found');
	const number = await take(tx, orgId, projectId, 'next');
	return { number, ref: `${p.key}-${number}` };
}

/** The next task number in the project. */
export async function allocateTaskNumber(
	tx: Tx,
	orgId: string,
	projectId: string
): Promise<number> {
	assertUuid(orgId, 'orgId');
	assertUuid(projectId, 'projectId');
	return take(tx, orgId, projectId, 'next_task');
}
